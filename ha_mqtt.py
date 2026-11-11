"""
Home Assistant bridge: publishes the mower over MQTT using HA device discovery
and executes commands sent back from HA.

The bridge never talks BLE itself. ``web_app`` stays the single BLE owner and
hands in everything the bridge needs through ``Hooks``, so planner logic and
smart/classic command handling are reused unchanged.
"""

import asyncio
import datetime as dt
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

import aiomqtt

from automower_ble.error_codes import ErrorCodes
from automower_ble.protocol import MowerActivity, MowerState

logger = logging.getLogger("ha_mqtt")

_ONLINE = "online"
_OFFLINE = "offline"
_PERIODIC_S = 30
_STATS_INTERVAL_S = 1800
_COMMAND_WAIT_S = 75      # covers one reconnect-loop cycle plus scan and connect
_POST_COMMAND_DELAY_S = 3
_MAX_STATE_TEXT = 250     # HA rejects entity states longer than 255 characters

# Topic suffix -> (web_app command name, takes mow_hours)
_COMMANDS = {
    "start": ("mow", True),
    "pause": ("pause", False),
    "dock": ("park", False),
    "resume": ("resume", False),
    "park_home": ("park_home", False),
}


@dataclass(frozen=True)
class MqttConfig:
    host: str
    port: int = 1883
    username: Optional[str] = None
    password: Optional[str] = None
    prefix: str = "automower"
    discovery_prefix: str = "homeassistant"


@dataclass
class Hooks:
    """Everything the bridge needs from web_app; keeps this module import-cycle free."""

    is_connected: Callable[[], bool]
    wake: Callable[[], None]
    address: Callable[[], Optional[str]]
    read_identity: Callable[[], Awaitable[dict]]
    read_live: Callable[[], Awaitable[Optional[dict]]]
    read_stats: Callable[[], Awaitable[Optional[dict]]]
    planner_snapshot: Callable[[], dict]
    run_command: Callable[[str, dict], Awaitable[str]]
    set_planner_enabled: Callable[[bool], Awaitable[None]]
    set_watchdog_enabled: Callable[[bool], None]


def ha_activity(
    activity: Optional[MowerActivity],
    state: Optional[MowerState],
    error_code: Optional[int],
) -> Optional[str]:
    """Map mower state onto the lawn_mower activities HA understands."""
    if (
        state in (MowerState.ERROR, MowerState.FATAL_ERROR, MowerState.STOPPED,
                  MowerState.WAIT_FOR_SAFETYPIN)
        or activity == MowerActivity.STOPPED_IN_GARDEN
        or error_code
    ):
        return "error"
    if state == MowerState.PAUSED:
        return "paused"
    if activity in (MowerActivity.MOWING, MowerActivity.GOING_OUT):
        return "mowing"
    if activity == MowerActivity.GOING_HOME:
        return "returning"
    if activity in (MowerActivity.CHARGING, MowerActivity.PARKED, MowerActivity.NONE):
        return "docked"
    return None


def _onoff(value: Any) -> str:
    return "ON" if value else "OFF"


def _clip(text: str) -> str:
    return text if len(text) <= _MAX_STATE_TEXT else text[: _MAX_STATE_TEXT - 1] + "…"


class HaBridge:
    def __init__(self, cfg: MqttConfig, hooks: Hooks) -> None:
        self._cfg = cfg
        self._hooks = hooks
        self._task: Optional[asyncio.Task] = None
        self._client: Optional[aiomqtt.Client] = None
        self._cmd_lock = asyncio.Lock()
        self._cmd_tasks: set[asyncio.Task] = set()
        self._identity: dict = {}
        self._published_identity: Optional[dict] = None
        self._state: dict[str, Any] = {"mow_hours": 3.0}
        self._ble_was_connected = False
        self._last_stats = 0.0

    # ── Topics ────────────────────────────────────────────────────────────────
    @property
    def _hex(self) -> str:
        addr = self._hooks.address()
        return addr.replace(":", "").lower() if addr else "mower"

    @property
    def base(self) -> str:
        return f"{self._cfg.prefix}/{self._hex}"

    @property
    def availability_topic(self) -> str:
        return f"{self.base}/availability"

    @property
    def state_topic(self) -> str:
        return f"{self.base}/state"

    # ── Lifecycle ─────────────────────────────────────────────────────────────
    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="ha-mqtt")

    async def stop(self) -> None:
        if self._task is None:
            return
        # A clean disconnect does not fire the LWT, so announce offline ourselves.
        await self._publish(self.availability_topic, _OFFLINE, retain=True)
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):
            pass
        self._task = None

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            will = aiomqtt.Will(self.availability_topic, _OFFLINE, retain=True)
            try:
                async with aiomqtt.Client(
                    self._cfg.host,
                    self._cfg.port,
                    username=self._cfg.username,
                    password=self._cfg.password,
                    will=will,
                ) as client:
                    self._client = client
                    backoff = 1.0
                    logger.info("MQTT connected to %s:%d", self._cfg.host, self._cfg.port)
                    await client.subscribe(f"{self.base}/cmd/+")
                    await self._announce()
                    async with asyncio.TaskGroup() as tg:
                        tg.create_task(self._listen(client))
                        tg.create_task(self._periodic())
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # MqttError or an ExceptionGroup from the TaskGroup
                logger.warning("MQTT connection lost: %s — retrying in %.0f s", exc, backoff)
            finally:
                self._client = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    async def _announce(self) -> None:
        """Publish discovery, availability and the full retained state."""
        await self._publish_discovery()
        await self._publish(self.availability_topic, _ONLINE, retain=True)
        self._refresh_planner()
        self._state["ble_connected"] = _onoff(self._hooks.is_connected())
        await self._publish_state()

    # ── Publishing ────────────────────────────────────────────────────────────
    async def _publish(self, topic: str, payload: str, retain: bool = False) -> None:
        client = self._client
        if client is None:
            return
        try:
            await client.publish(topic, payload, retain=retain)
        except aiomqtt.MqttError as exc:
            logger.debug("MQTT publish to %s failed: %s", topic, exc)

    async def _publish_state(self) -> None:
        await self._publish(self.state_topic, json.dumps(self._state), retain=True)

    def _refresh_planner(self) -> None:
        snap = self._hooks.planner_snapshot()
        self._state.update(
            planner_enabled=_onoff(snap.get("planner_enabled")),
            watchdog_enabled=_onoff(snap.get("watchdog_enabled")),
            watchdog_parked=_onoff(snap.get("watchdog_parked")),
            watchdog_status=_clip(snap.get("watchdog_status") or ""),
            smart_context=snap.get("smart_context"),
            next_start=snap.get("next_start"),
        )

    async def push_live(self, sample: Optional[dict]) -> None:
        """Take a sampler reading (battery, activity, charging, state, error_code)."""
        if not sample:
            return
        activity: Optional[MowerActivity] = sample.get("activity")
        state: Optional[MowerState] = sample.get("state")
        error_code = sample.get("error_code") or 0
        try:
            error_name = ErrorCodes(error_code).name if error_code else "NO_ERROR"
        except ValueError:
            error_name = f"UNKNOWN_{error_code}"
        self._state.update(
            battery=sample.get("battery"),
            activity=ha_activity(activity, state, error_code),
            mower_activity=activity.name if activity is not None else None,
            mower_state=state.name if state is not None else None,
            charging=_onoff(sample.get("charging")),
            error_code=error_code,
            error=error_name,
        )
        self._refresh_planner()
        await self._publish_state()

    async def push_planner(self) -> None:
        self._refresh_planner()
        await self._publish_state()

    # ── Periodic work ─────────────────────────────────────────────────────────
    async def _periodic(self) -> None:
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("HA bridge tick failed (ignored): %s", exc)
            await asyncio.sleep(_PERIODIC_S)

    async def _tick(self) -> None:
        connected = self._hooks.is_connected()
        if connected and not self._ble_was_connected:
            await self._on_ble_connected()
        self._ble_was_connected = connected
        # Statistics are only read over an existing link; never wake BLE idle sleep.
        if connected and time.monotonic() - self._last_stats > _STATS_INTERVAL_S:
            await self._read_stats()
        self._state["ble_connected"] = _onoff(connected)
        self._refresh_planner()
        await self._publish_state()

    async def _on_ble_connected(self) -> None:
        try:
            self._identity = await self._hooks.read_identity()
        except Exception as exc:
            logger.debug("HA bridge: identity read failed: %s", exc)
        if self._identity and self._identity != self._published_identity:
            await self._publish_discovery()
        await self.push_live(await self._hooks.read_live())
        await self._read_stats()

    async def _read_stats(self) -> None:
        self._last_stats = time.monotonic()
        try:
            stats = await self._hooks.read_stats()
        except Exception as exc:
            logger.debug("HA bridge: statistics read failed: %s", exc)
            return
        if stats:
            self._state.update(
                running_hours=stats.get("total_running_hours"),
                charging_cycles=stats.get("number_of_charging_cycles"),
                blade_wear_pct=stats.get("blade_wear_pct"),
            )

    # ── Commands from HA ──────────────────────────────────────────────────────
    async def _listen(self, client: aiomqtt.Client) -> None:
        async for msg in client.messages:
            topic = str(msg.topic)
            payload = msg.payload.decode(errors="replace").strip() if msg.payload else ""
            # Handlers may wait for BLE to come back; don't stall the receive loop.
            task = asyncio.create_task(self._handle(topic, payload))
            self._cmd_tasks.add(task)
            task.add_done_callback(self._cmd_tasks.discard)

    async def _handle(self, topic: str, payload: str) -> None:
        name = topic.rsplit("/", 1)[-1]
        try:
            if name == "mow_hours":
                self._state["mow_hours"] = max(0.5, min(12.0, float(payload)))
                await self._publish_state()
            elif name == "planner":
                await self._hooks.set_planner_enabled(payload.upper() == "ON")
                await self.push_planner()
            elif name == "watchdog":
                self._hooks.set_watchdog_enabled(payload.upper() == "ON")
                await self.push_planner()
            elif name in _COMMANDS:
                await self._run_mower_command(name)
            else:
                logger.debug("HA bridge: ignoring unknown command topic %s", topic)
        except Exception as exc:
            logger.warning("HA command %s failed: %s", name, exc)
            await self._set_last_command(f"{name}: failed — {exc}")

    async def _run_mower_command(self, name: str) -> None:
        cmd, takes_hours = _COMMANDS[name]
        args = {"duration_hours": self._state["mow_hours"]} if takes_hours else {}
        async with self._cmd_lock:
            if not await self._ensure_connected():
                await self._set_last_command(f"{name}: mower not reachable")
                return
            result = await self._hooks.run_command(cmd, args)
            await self._set_last_command(f"{name}: {result}")
        # Give the mower a moment to change state before reporting it back.
        await asyncio.sleep(_POST_COMMAND_DELAY_S)
        await self.push_live(await self._hooks.read_live())

    async def _ensure_connected(self) -> bool:
        if self._hooks.is_connected():
            return True
        self._hooks.wake()
        for _ in range(_COMMAND_WAIT_S):
            await asyncio.sleep(1)
            if self._hooks.is_connected():
                return True
        return False

    async def _set_last_command(self, text: str) -> None:
        self._state["last_command"] = _clip(f"{dt.datetime.now():%H:%M} {text}")
        await self._publish_state()

    # ── Discovery ─────────────────────────────────────────────────────────────
    def discovery_payload(self) -> dict:
        uid = f"automower_{self._hex}"
        base = self.base
        ident = self._identity
        device = {
            "identifiers": [uid],
            "name": ident.get("name") or "Sir Schnittalot",
            "manufacturer": ident.get("manufacturer") or "Husqvarna",
        }
        if ident.get("model"):
            device["model"] = ident["model"]
        if ident.get("serial") is not None:
            device["serial_number"] = str(ident["serial"])

        def tpl(key: str) -> str:
            return "{{ value_json.%s }}" % key

        # name=None makes the entity take the device name (the lawn_mower entity)
        def comp(platform: str, key: str, name: Optional[str], **extra: Any) -> tuple[str, dict]:
            return key, {"platform": platform, "unique_id": f"{uid}_{key}", "name": name, **extra}

        def sensor(key: str, name: str, **extra: Any) -> tuple[str, dict]:
            return comp("sensor", key, name, state_topic=self.state_topic,
                        value_template=tpl(key), **extra)

        def binary(key: str, name: str, **extra: Any) -> tuple[str, dict]:
            return comp("binary_sensor", key, name, state_topic=self.state_topic,
                        value_template=tpl(key), **extra)

        def switch(key: str, name: str) -> tuple[str, dict]:
            return comp("switch", key, name, state_topic=self.state_topic,
                        value_template=tpl(f"{key}_enabled"),
                        command_topic=f"{base}/cmd/{key}")

        def button(key: str, name: str, **extra: Any) -> tuple[str, dict]:
            return comp("button", key, name, command_topic=f"{base}/cmd/{key}", **extra)

        components = dict([
            comp(
                "lawn_mower", "mower", None,
                activity_state_topic=self.state_topic,
                activity_value_template=tpl("activity"),
                start_mowing_command_topic=f"{base}/cmd/start",
                pause_command_topic=f"{base}/cmd/pause",
                dock_command_topic=f"{base}/cmd/dock",
            ),
            sensor("battery", "Battery", device_class="battery",
                   unit_of_measurement="%", state_class="measurement"),
            sensor("mower_activity", "Activity", entity_category="diagnostic"),
            sensor("mower_state", "State", entity_category="diagnostic"),
            sensor("error", "Error", entity_category="diagnostic"),
            sensor("smart_context", "Session"),
            sensor("next_start", "Next start", device_class="timestamp"),
            sensor("running_hours", "Running time", device_class="duration",
                   unit_of_measurement="h", state_class="total_increasing"),
            sensor("charging_cycles", "Charging cycles", state_class="total_increasing"),
            sensor("blade_wear_pct", "Blade wear", unit_of_measurement="%",
                   state_class="measurement"),
            sensor("watchdog_status", "Weather watchdog", entity_category="diagnostic"),
            sensor("last_command", "Last HA command", entity_category="diagnostic"),
            binary("charging", "Charging", device_class="battery_charging"),
            binary("ble_connected", "Bluetooth link", device_class="connectivity",
                   entity_category="diagnostic"),
            binary("watchdog_parked", "Parked by weather watchdog"),
            switch("planner", "Smart planner"),
            switch("watchdog", "Weather watchdog enabled"),
            button("resume", "Resume"),
            button("park_home", "Park until further notice"),
            comp("number", "mow_hours", "Mow duration", state_topic=self.state_topic,
                 value_template=tpl("mow_hours"), command_topic=f"{base}/cmd/mow_hours",
                 min=0.5, max=12, step=0.5, unit_of_measurement="h", mode="box"),
        ])
        return {
            "device": device,
            "origin": {"name": "AutoMower-BLE"},
            "availability_topic": self.availability_topic,
            "components": components,
        }

    async def _publish_discovery(self) -> None:
        topic = f"{self._cfg.discovery_prefix}/device/automower_{self._hex}/config"
        await self._publish(topic, json.dumps(self.discovery_payload()), retain=True)
        self._published_identity = dict(self._identity)
