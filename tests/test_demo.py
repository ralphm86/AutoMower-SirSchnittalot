"""Tests for the simulated demo mower and demo-mode wiring in the web app."""

import time

import pytest

from automower_ble.demo import DEMO_ADDRESS, DemoMower
from automower_ble.protocol import (
    ModeOfOperation,
    MowerActivity,
    MowerState,
    OverrideAction,
    TaskInformation,
)


def run(mower: DemoMower, seconds: int, t: float | None = None) -> float:
    """Drive the simulation by *seconds* real seconds on a fake wall clock."""
    t = time.time() if t is None else t
    for _ in range(seconds):
        t += 1.0
        mower._step(1.0, t)
    return t


@pytest.fixture
def mower():
    m = DemoMower(speed=10.0, seed=1)
    m._tasks = []  # no weekly schedule: the mower only moves when told to
    return m


async def test_starts_parked_and_full(mower):
    assert await mower.battery_level() == 100
    assert await mower.mower_activity() == MowerActivity.PARKED
    assert await mower.mower_state() == MowerState.RESTRICTED
    assert not await mower.is_charging()


async def test_override_mows_then_recharges_and_resumes(mower):
    await mower.mower_override_seconds(3 * 3600)
    assert await mower.mower_state() == MowerState.IN_OPERATION

    t = run(mower, 1)
    assert await mower.mower_activity() == MowerActivity.GOING_OUT
    t = run(mower, 120, t)
    assert await mower.mower_activity() == MowerActivity.MOWING

    seen = set()
    for _ in range(3000):
        t = run(mower, 1, t)
        seen.add(mower._status(t)[1])
        if MowerActivity.CHARGING in seen:
            break
    assert {MowerActivity.GOING_HOME, MowerActivity.CHARGING} <= seen
    assert await mower.is_charging()
    assert await mower.command("GetRemainingChargingTime") > 0

    # The override is still active, so it heads out again once recharged.
    for _ in range(3000):
        t = run(mower, 1, t)
        if mower._phase == "mow":
            break
    assert mower._phase == "mow"
    assert mower._battery >= 90


async def test_override_expiry_sends_mower_home(mower):
    await mower.mower_override_seconds(60)
    t = run(mower, 120)  # past the 60 s override
    t = run(mower, 120, t)
    assert mower._phase in ("home", "docked")
    assert await mower.command("GetOverride") == {"action": 0, "startTime": 0, "duration": 0}


async def test_pause_freezes_and_resume_continues(mower):
    await mower.mower_override_seconds(3600)
    t = run(mower, 120)
    assert mower._phase == "mow"

    await mower.mower_pause()
    battery = mower._battery
    t = run(mower, 30, t)
    assert await mower.mower_state() == MowerState.PAUSED
    assert await mower.mower_activity() == MowerActivity.STOPPED_IN_GARDEN
    assert mower._battery == battery

    await mower.mower_resume()  # clears the override, so it heads home
    t = run(mower, 1, t)
    assert await mower.mower_state() != MowerState.PAUSED


async def test_park_home_blocks_forced_mowing(mower):
    await mower.mower_park_home()
    await mower.command("SetOverrideMow", duration=3600)
    run(mower, 60)
    assert mower._phase == "docked"
    assert await mower.mower_mode() == ModeOfOperation.HOME

    await mower.mower_resume()
    await mower.mower_override_seconds(3600)
    run(mower, 5)
    assert mower._phase != "docked"


async def test_park_override_reported(mower):
    await mower.mower_park_duration(1.0)
    ov = await mower.command("GetOverride")
    assert ov["action"] == OverrideAction.FORCEDPARK
    assert ov["duration"] == 3600
    assert await mower.command("GetRestrictionReason") == 2


async def test_schedule_roundtrip_and_auto_start(mower):
    import datetime as dt

    now = dt.datetime.now()
    start = (now - dt.timedelta(minutes=5)).replace(second=0, microsecond=0)
    if start.date() != now.date():  # just after midnight
        pytest.skip("window would start yesterday")
    task = TaskInformation(
        next_start_time=start.hour * 3600 + start.minute * 60,
        duration_in_seconds=3600,
        on_monday=1, on_tuesday=1, on_wednesday=1, on_thursday=1,
        on_friday=1, on_saturday=1, on_sunday=1,
    )
    await mower.set_schedule([task])
    tasks = await mower.get_all_tasks()
    assert len(tasks) == 1
    assert tasks[0].duration_in_seconds == 3600
    assert tasks[0].on_sunday

    run(mower, 120)
    assert mower._phase in ("out", "mow")


async def test_next_start_time_empty_without_tasks(mower):
    assert await mower.mower_next_start_time() is None


async def test_statistics_advance_while_mowing(mower):
    before = await mower.command("GetAllStatistics")
    await mower.mower_override_seconds(3600)
    run(mower, 300)
    after = await mower.command("GetAllStatistics")
    assert after["totalCuttingTime"] > before["totalCuttingTime"]
    assert after["cuttingBladeUsageTime"] > before["cuttingBladeUsageTime"]
    await mower.cmd_reset_blade_time()
    assert (await mower.command("GetAllStatistics"))["cuttingBladeUsageTime"] == 0


async def test_identity_and_messages(mower):
    assert await mower.get_manufacturer() == "Husqvarna"
    assert await mower.get_model() == "Automower 450X"
    assert await mower.get_supports_cutting_height()
    total = await mower.command("GetNumberOfMessages")
    assert total > 0
    assert (await mower.command("GetMessage", messageId=0))["code"] >= 0
    assert await mower.command("GetMessage", messageId=total) is None


async def test_gps_fix_follows_position(mower):
    await mower.mower_override_seconds(3600)
    run(mower, 300)
    a = mower.gps_fix()
    run(mower, 30)
    b = mower.gps_fix()
    assert (a["lat"], a["lon"]) != (b["lat"], b["lon"])
    assert abs(a["lat"] - mower.origin[0]) < 0.01


def test_rejects_non_positive_speed():
    with pytest.raises(ValueError):
        DemoMower(speed=0)


# ─── Web app wiring ───────────────────────────────────────────────────────────
@pytest.fixture
def demo_web(web, monkeypatch):
    monkeypatch.setattr(web, "_demo", True)
    monkeypatch.setattr(web, "_demo_mower", DemoMower(speed=10.0, seed=1))
    return web


def test_demo_scan_lists_fake_device(demo_web, client):
    devices = client.get("/api/scan").json()
    assert devices == [{
        "address": DEMO_ADDRESS, "name": "Automower (demo)", "rssi": -52, "husqvarna": True,
    }]


def test_demo_connect_status_and_command(demo_web, client):
    r = client.post("/api/connect", json={"address": DEMO_ADDRESS, "channel_id": 1})
    assert r.status_code == 200
    assert client.get("/api/connection").json()["demo"] is True

    status = client.get("/api/status").json()
    assert status["manufacturer"] == "Husqvarna"
    assert status["battery_level"] == 100

    assert client.post("/api/command/mow", json={"duration_hours": 1}).status_code == 200
    assert client.get("/api/status").json()["state"] == "IN_OPERATION"

    assert client.post("/api/disconnect").status_code == 200
    assert client.get("/api/connection").json()["connected"] is False
