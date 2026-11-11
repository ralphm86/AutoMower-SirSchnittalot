"""Home Assistant MQTT bridge: state mapping, discovery payload and command handling."""

import json

import pytest

pytest.importorskip("aiomqtt")

import ha_mqtt  # noqa: E402
from automower_ble.protocol import MowerActivity, MowerState  # noqa: E402


class FakeClient:
    def __init__(self):
        self.published = []

    async def publish(self, topic, payload, retain=False, **_):
        self.published.append((topic, payload, retain))

    def last_state(self):
        states = [p for t, p, _ in self.published if t.endswith("/state")]
        return json.loads(states[-1])


class FakeHooks:
    def __init__(self, connected=True):
        self.connected = connected
        self.woken = False
        self.commands = []
        self.fail_with = None
        self.planner_calls = []
        self.watchdog_calls = []

    def hooks(self):
        async def read_identity():
            return {"name": "Sir Schnittalot", "model": "Automower 305", "serial": 42}

        async def read_live():
            return None

        async def read_stats():
            return None

        async def run_command(name, args):
            if self.fail_with:
                raise RuntimeError(self.fail_with)
            self.commands.append((name, args))
            return "done"

        async def set_planner(enabled):
            self.planner_calls.append(enabled)

        def wake():
            self.woken = True

        return ha_mqtt.Hooks(
            is_connected=lambda: self.connected,
            wake=wake,
            address=lambda: "AA:BB:CC:DD:EE:FF",
            read_identity=read_identity,
            read_live=read_live,
            read_stats=read_stats,
            planner_snapshot=lambda: {
                "planner_enabled": True,
                "watchdog_enabled": False,
                "watchdog_parked": False,
                "watchdog_status": "ok",
                "smart_context": "Next: Mon",
                "next_start": None,
            },
            run_command=run_command,
            set_planner_enabled=set_planner,
            set_watchdog_enabled=self.watchdog_calls.append,
        )


@pytest.fixture
def fake():
    return FakeHooks()


@pytest.fixture
def bridge(fake, monkeypatch):
    monkeypatch.setattr(ha_mqtt, "_POST_COMMAND_DELAY_S", 0)
    monkeypatch.setattr(ha_mqtt, "_COMMAND_WAIT_S", 0)
    b = ha_mqtt.HaBridge(ha_mqtt.MqttConfig(host="broker"), fake.hooks())
    b._client = FakeClient()
    return b


class TestActivityMapping:
    @pytest.mark.parametrize(
        "activity,state,error,expected",
        [
            (MowerActivity.MOWING, MowerState.IN_OPERATION, 0, "mowing"),
            (MowerActivity.GOING_OUT, MowerState.IN_OPERATION, 0, "mowing"),
            (MowerActivity.GOING_HOME, MowerState.IN_OPERATION, 0, "returning"),
            (MowerActivity.CHARGING, MowerState.IN_OPERATION, 0, "docked"),
            (MowerActivity.PARKED, MowerState.RESTRICTED, 0, "docked"),
            (MowerActivity.MOWING, MowerState.PAUSED, 0, "paused"),
            (MowerActivity.STOPPED_IN_GARDEN, MowerState.STOPPED, 0, "error"),
            (MowerActivity.PARKED, MowerState.ERROR, 0, "error"),
            (MowerActivity.PARKED, MowerState.IN_OPERATION, 5, "error"),
        ],
    )
    def test_mapping(self, activity, state, error, expected):
        assert ha_mqtt.ha_activity(activity, state, error) == expected


class TestDiscovery:
    def test_device_payload_shape(self, bridge):
        p = bridge.discovery_payload()
        assert p["device"]["identifiers"] == ["automower_aabbccddeeff"]
        assert p["availability_topic"] == "automower/aabbccddeeff/availability"
        assert p["components"]["mower"]["platform"] == "lawn_mower"
        assert p["components"]["mower"]["name"] is None

    def test_unique_ids_are_unique_and_prefixed(self, bridge):
        ids = [c["unique_id"] for c in bridge.discovery_payload()["components"].values()]
        assert len(ids) == len(set(ids))
        assert all(i.startswith("automower_aabbccddeeff_") for i in ids)

    def test_every_command_topic_is_under_the_subscribed_wildcard(self, bridge):
        for comp in bridge.discovery_payload()["components"].values():
            for key, value in comp.items():
                if key.endswith("command_topic"):
                    assert value.startswith(f"{bridge.base}/cmd/")

    def test_identity_is_added_once_known(self, bridge):
        bridge._identity = {"name": "Rasenmeister", "model": "Automower 305", "serial": 42}
        dev = bridge.discovery_payload()["device"]
        assert dev["name"] == "Rasenmeister"
        assert dev["model"] == "Automower 305"
        assert dev["serial_number"] == "42"


class TestState:
    async def test_push_live_publishes_retained_json(self, bridge):
        await bridge.push_live({
            "battery": 77,
            "activity": MowerActivity.MOWING,
            "charging": False,
            "state": MowerState.IN_OPERATION,
            "error_code": None,
        })
        topic, payload, retain = bridge._client.published[-1]
        assert topic == "automower/aabbccddeeff/state" and retain is True
        body = json.loads(payload)
        assert body["battery"] == 77
        assert body["activity"] == "mowing"
        assert body["charging"] == "OFF"
        assert body["error"] == "NO_ERROR"
        assert body["planner_enabled"] == "ON"

    async def test_no_publish_without_broker_connection(self, bridge):
        bridge._client = None
        await bridge.push_planner()  # must not raise


class TestCommands:
    async def test_start_uses_the_configured_mow_hours(self, bridge, fake):
        await bridge._handle(f"{bridge.base}/cmd/mow_hours", "1.5")
        await bridge._handle(f"{bridge.base}/cmd/start", "start_mowing")
        assert fake.commands == [("mow", {"duration_hours": 1.5})]

    async def test_mow_hours_is_clamped(self, bridge):
        await bridge._handle(f"{bridge.base}/cmd/mow_hours", "99")
        assert bridge._state["mow_hours"] == 12.0

    @pytest.mark.parametrize(
        "topic,command",
        [("pause", "pause"), ("dock", "park"), ("resume", "resume"), ("park_home", "park_home")],
    )
    async def test_topics_route_to_commands(self, bridge, fake, topic, command):
        await bridge._handle(f"{bridge.base}/cmd/{topic}", "PRESS")
        assert fake.commands == [(command, {})]
        assert "done" in bridge._state["last_command"]

    async def test_unreachable_mower_wakes_ble_and_reports(self, bridge, fake):
        fake.connected = False
        await bridge._handle(f"{bridge.base}/cmd/pause", "pause")
        assert fake.woken is True
        assert fake.commands == []
        assert "not reachable" in bridge._state["last_command"]

    async def test_failure_is_reported_not_raised(self, bridge, fake):
        fake.fail_with = "Not connected to any mower"
        await bridge._handle(f"{bridge.base}/cmd/pause", "pause")
        assert "failed" in bridge._state["last_command"]

    async def test_switches(self, bridge, fake):
        await bridge._handle(f"{bridge.base}/cmd/planner", "OFF")
        await bridge._handle(f"{bridge.base}/cmd/watchdog", "ON")
        assert fake.planner_calls == [False]
        assert fake.watchdog_calls == [True]

    async def test_long_status_text_is_clipped(self, bridge):
        await bridge._set_last_command("x" * 400)
        assert len(bridge._state["last_command"]) <= 255


class TestWebAppWiring:
    def test_bridge_is_off_by_default(self, web):
        assert web._ha_bridge is None

    def test_cli_overrides_env_one_field_at_a_time(self, web, monkeypatch):
        monkeypatch.setattr(web, "_mqtt_cfg", {"host": "env-host", "port": 1883, "password": "pw"})
        web._init_mqtt(None, None, "ha-user")
        assert web._mqtt_cfg == {
            "host": "env-host", "port": 1883, "password": "pw", "username": "ha-user",
        }

    def test_snapshot_in_classic_mode_has_no_planner_fields(self, web):
        snap = web._ha_planner_snapshot()
        assert snap["planner_enabled"] is False
        assert snap["smart_context"] is None
        assert snap["next_start"] is None

    async def test_run_command_surfaces_missing_connection(self, web):
        with pytest.raises(RuntimeError, match="Not connected"):
            await web._ha_run_command("pause", {})

    async def test_run_command_pause_reaches_the_mower(self, web, connected_client):
        msg = await web._ha_run_command("pause", {})
        assert "paused" in msg.lower()
        web._mower.mower_pause.assert_awaited_once()
