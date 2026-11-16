"""
Use-case / integration tests for the FastAPI web layer (web_app.py).

These exercise the real ASGI app end-to-end (routing, request validation,
auth middleware, response shaping) while the BLE ``Mower`` is replaced by an
``AsyncMock`` — so no Bluetooth hardware is required.
"""

import time

import bcrypt
import pytest
from fastapi.testclient import TestClient

from automower_ble.protocol import MowerActivity

# GPS fixes must carry a plausible (not future) timestamp.
T0 = int(time.time()) - 3600


# ─── Connection guard ─────────────────────────────────────────────────────────
class TestConnectionGuard:
    def test_status_requires_connection(self, client):
        assert client.get("/api/status").status_code == 400

    def test_statistics_requires_connection(self, client):
        assert client.get("/api/statistics").status_code == 400

    def test_schedule_requires_connection(self, client):
        assert client.get("/api/schedule").status_code == 400


# ─── Status use case ──────────────────────────────────────────────────────────
class TestStatus:
    def test_reports_mowing(self, connected_client):
        r = connected_client.get("/api/status")
        assert r.status_code == 200
        body = r.json()
        assert body["connected"] is True
        assert body["activity"] == "MOWING"
        assert body["activity_description"] == "Mowing lawn"
        assert body["battery_level"] == 80
        assert body["charging"] is False
        assert body["model"] == "Automower 305"
        assert body["control_mode"] == "classic"

    def test_charging_adds_estimated_next_start(self, web, connected_client):
        web._mower.is_charging.return_value = True

        async def _cmd(name, **kw):
            if name == "GetRemainingChargingTime":
                return 3600
            return {
                "GetUserMowerNameAsAsciiString": "Sir Schnittalot",
                "GetSerialNumber": 1,
                "GetError": 0,
                "GetRestrictionReason": 0,
            }.get(name)

        web._mower.command.side_effect = _cmd
        body = connected_client.get("/api/status").json()
        assert body["charging"] is True
        assert body["remaining_charging_min"] == 60.0
        assert body["estimated_next_start_time"] is not None

    def test_smart_context_mowing_from_active_session(self, web, connected_client, monkeypatch):
        import datetime as dt

        monkeypatch.setattr(web, "planner_load_config", lambda: {"enabled": True})
        web.planner._user_inhibited = False
        web.planner._active_session = {
            "start_dt": dt.datetime.now() - dt.timedelta(minutes=30),
            "duration_sec": 3600,
        }
        body = connected_client.get("/api/status").json()
        assert body["smart_context"].startswith("Mowing until ")

    def test_smart_context_mowing_from_firmware_override(self, web, connected_client, monkeypatch):
        # _active_session is None (e.g. after a restart/reconnect) but the mower
        # is actually mowing under a FORCEDMOW override — the Session field must
        # still show the current session, not the next planned one.
        import calendar as _cal
        import datetime as dt
        from automower_ble.protocol import OverrideAction

        monkeypatch.setattr(web, "planner_load_config", lambda: {"enabled": True})
        web.planner._user_inhibited = False
        web.planner._active_session = None

        start_local = int(_cal.timegm((dt.datetime.now() - dt.timedelta(minutes=15)).timetuple()))

        async def _cmd(name, **kw):
            if name == "GetOverride":
                return {
                    "action": OverrideAction.FORCEDMOW.value,
                    "startTime": start_local,
                    "duration": 3600,
                }
            return {
                "GetUserMowerNameAsAsciiString": "Sir Schnittalot",
                "GetSerialNumber": 1,
                "GetError": 0,
                "GetRestrictionReason": 0,
            }.get(name)

        web._mower.command.side_effect = _cmd
        body = connected_client.get("/api/status").json()
        assert body["smart_context"].startswith("Mowing until ")

    def test_smart_context_charging_shows_resume_and_end(self, web, connected_client, monkeypatch):
        import datetime as dt
        from automower_ble.protocol import MowerActivity

        monkeypatch.setattr(web, "planner_load_config", lambda: {"enabled": True})
        web.planner._user_inhibited = False
        web.planner._active_session = {
            "start_dt": dt.datetime.now() - dt.timedelta(minutes=30),
            "duration_sec": 7200,
        }
        web._mower.mower_activity.return_value = MowerActivity.CHARGING
        web._mower.is_charging.return_value = True

        async def _cmd(name, **kw):
            if name == "GetRemainingChargingTime":
                return 1800
            return {
                "GetUserMowerNameAsAsciiString": "Sir Schnittalot",
                "GetSerialNumber": 1,
                "GetError": 0,
                "GetRestrictionReason": 0,
            }.get(name)

        web._mower.command.side_effect = _cmd
        body = connected_client.get("/api/status").json()
        ctx = body["smart_context"]
        assert ctx.startswith("Charging until ~")
        assert "mowing until" in ctx


# ─── Connection lifecycle ─────────────────────────────────────────────────────
class TestConnection:
    def test_connection_status_disconnected(self, client):
        body = client.get("/api/connection").json()
        assert body["connected"] is False
        assert body["address"] is None

    def test_connection_status_connected(self, connected_client):
        body = connected_client.get("/api/connection").json()
        assert body["connected"] is True
        assert body["address"] == "AA:BB:CC:DD:EE:FF"

    def test_stale_connection_is_cleaned_up(self, web, connected_client, monkeypatch):
        # Simulate a BLE drop that bypassed /api/disconnect.
        web._mower.is_connected.return_value = False
        monkeypatch.setattr(web.subprocess, "run", lambda *a, **k: None)
        body = connected_client.get("/api/connection").json()
        assert body["connected"] is False
        assert web._connected is False

    def test_disconnect(self, web, connected_client):
        r = connected_client.post("/api/disconnect")
        assert r.status_code == 200
        assert r.json()["status"] == "disconnected"
        web._mower_was = None  # mower is cleared
        assert web._connected is False


# ─── Commands: classic mode ───────────────────────────────────────────────────
class TestClassicCommands:
    def test_mow_calls_override(self, connected_client, web):
        r = connected_client.post("/api/command/mow", json={"duration_hours": 2})
        assert r.status_code == 200
        body = r.json()
        assert body["control_mode"] == "classic"
        web._mower.mower_override.assert_awaited_once_with(2)

    def test_mow_rejects_zero_duration(self, connected_client):
        r = connected_client.post("/api/command/mow", json={"duration_hours": 0})
        assert r.status_code == 422

    def test_pause(self, connected_client, web):
        r = connected_client.post("/api/command/pause")
        assert r.status_code == 200
        web._mower.mower_pause.assert_awaited_once()

    def test_resume(self, connected_client, web):
        r = connected_client.post("/api/command/resume")
        assert r.status_code == 200
        web._mower.mower_resume.assert_awaited_once()

    def test_park(self, connected_client, web):
        r = connected_client.post("/api/command/park")
        assert r.status_code == 200
        assert r.json()["action"] == "park_until_next_start"
        web._mower.mower_park.assert_awaited_once()

    def test_park_home(self, connected_client, web):
        r = connected_client.post("/api/command/park_home")
        assert r.status_code == 200
        web._mower.mower_park_home.assert_awaited_once()


# ─── Commands: smart (planner) mode ───────────────────────────────────────────
@pytest.fixture
def smart(web, monkeypatch):
    """Switch the app into smart/planner mode and reset planner runtime state."""
    monkeypatch.setattr(web, "planner_load_config", lambda: {"enabled": True})
    web.planner._user_inhibited = False
    web.planner._active_session = None
    return web.planner


class TestSmartCommands:
    def test_mow_sets_synthetic_session_and_clears_inhibit(
        self, connected_client, web, smart
    ):
        smart._user_inhibited = True
        r = connected_client.post("/api/command/mow", json={"duration_hours": 1.5})
        assert r.status_code == 200
        assert r.json()["control_mode"] == "smart"
        assert smart._user_inhibited is False
        assert smart._active_session is not None
        assert smart._active_session["dow_name"] == "Manual"
        assert smart._active_session["duration_sec"] == int(1.5 * 3600)

    def test_pause_sets_user_inhibit(self, connected_client, web, smart):
        r = connected_client.post("/api/command/pause")
        assert r.status_code == 200
        assert smart._user_inhibited is True

    def test_resume_clears_user_inhibit(self, connected_client, web, smart):
        smart._user_inhibited = True
        r = connected_client.post("/api/command/resume")
        assert r.status_code == 200
        assert smart._user_inhibited is False

    def test_park_no_active_session_is_noop(self, connected_client, web, smart):
        r = connected_client.post("/api/command/park")
        assert r.status_code == 200
        assert r.json()["action"] == "no_active_session"
        web._mower.mower_park_home.assert_not_awaited()

    def test_park_cancels_active_session(self, connected_client, web, smart):
        import datetime as dt

        smart._active_session = {
            "date": str(dt.date.today()),
            "dow_name": "Monday",
            "start_dt": dt.datetime.now(),
            "duration_sec": 3600,
        }
        r = connected_client.post("/api/command/park")
        assert r.status_code == 200
        assert r.json()["action"] == "session_cancelled"
        assert smart._active_session is None
        web._mower.mower_park_home.assert_awaited_once()

    def test_park_home_inhibits_and_clears_session(self, connected_client, web, smart):
        smart._active_session = {"x": 1}
        r = connected_client.post("/api/command/park_home")
        assert r.status_code == 200
        assert smart._user_inhibited is True
        assert smart._active_session is None


# ─── Schedule ─────────────────────────────────────────────────────────────────
class TestSchedule:
    def test_set_schedule_blocked_in_planner_mode(self, connected_client, web, monkeypatch):
        monkeypatch.setattr(web, "planner_load_config", lambda: {"enabled": True})
        r = connected_client.post("/api/schedule", json={"tasks": []})
        assert r.status_code == 409

    def test_set_schedule_classic(self, connected_client, web):
        payload = {
            "tasks": [
                {
                    "start_seconds": 36000,
                    "duration_seconds": 7200,
                    "monday": True,
                    "wednesday": True,
                }
            ]
        }
        r = connected_client.post("/api/schedule", json=payload)
        assert r.status_code == 200
        assert r.json()["tasks_set"] == 1
        web._mower.set_schedule.assert_awaited_once()

    def test_get_schedule_empty(self, connected_client):
        body = connected_client.get("/api/schedule").json()
        assert body["task_count"] == 0
        assert body["tasks"] == []


# ─── Statistics ───────────────────────────────────────────────────────────────
class TestStatistics:
    def test_derived_metrics(self, connected_client):
        body = connected_client.get("/api/statistics").json()
        assert body["total_running_hours"] == 100.0
        assert body["number_of_charging_cycles"] == 40
        # cutting_ratio = 300000/360000*100
        assert body["cutting_ratio_pct"] == pytest.approx(83.3, abs=0.1)
        assert body["blade_wear_pct"] == pytest.approx(25.0, abs=0.1)


# ─── Runtime estimate ─────────────────────────────────────────────────────────
class TestRuntimeEstimate:
    def test_rejects_zero_duration(self, connected_client):
        assert connected_client.get("/api/runtime_estimate?duration_hours=0").status_code == 422

    def test_falls_back_to_statistics(self, connected_client):
        body = connected_client.get("/api/runtime_estimate?duration_hours=3").json()
        # No samples loaded → statistics-based source.
        assert body["data_source"] in ("statistics", "insufficient_data")

    def test_clear_samples(self, connected_client):
        r = connected_client.delete("/api/runtime_samples")
        assert r.status_code == 200
        assert r.json()["sample_count"] == 0


# ─── GPS location and lawn coverage ───────────────────────────────────────────
class TestGpsCoverage:
    @staticmethod
    def _post_fix(client, ts, lat, lon, **kw):
        return client.post("/api/gps/update",
                           json={"ts": ts, "lat": lat, "lon": lon, **kw})

    def test_empty_track(self, client):
        body = client.get("/api/gps/track").json()
        assert body["current"] is None
        assert body["track"] == []

    def test_update_and_read_back(self, client):
        r = self._post_fix(client, T0, 52.52, 13.405, accuracy_m=1.5)
        assert r.status_code == 200
        assert r.json()["track_length"] == 1

        body = client.get("/api/gps/track?session=all").json()
        assert body["current"]["lat"] == 52.52
        assert body["current"]["accuracy_m"] == 1.5

    def test_mowing_fix_creates_a_session(self, client):
        self._post_fix(client, T0, 52.52, 13.405, mowing=True)
        sessions = client.get("/api/sessions?with_coverage=true").json()["sessions"]
        assert len(sessions) == 1
        assert sessions[0]["active"] is True

    def test_coverage_grid(self, client):
        for i in range(4):
            self._post_fix(client, T0 + i * 10,
                           52.5200 + i * 0.000045, 13.4050, mowing=True)

        body = client.get("/api/gps/coverage?session=live&cell_m=1").json()
        assert len(body["cells"]) == 3
        assert body["covered_m2"] == 3.0
        assert body["bounds"] is not None
        assert all(0.0 <= c["w"] <= 1.0 for c in body["cells"])

    def test_coverage_reports_cell_size_in_degrees(self, client):
        """The map needs this to draw true-to-scale cells instead of blobs."""
        for i in range(2):
            self._post_fix(client, T0 + i * 10,
                           52.5200 + i * 0.000045, 13.4050, mowing=True)
        body = client.get("/api/gps/coverage?session=live&cell_m=1").json()
        d_lat, d_lon = body["cell_deg"]
        assert d_lat == pytest.approx(1 / 111320.0, rel=1e-6)
        assert d_lon > d_lat        # a degree of longitude is shorter this far north

    def test_coverage_cell_size_is_validated(self, client):
        assert client.get("/api/gps/coverage?cell_m=0").status_code == 422
        assert client.get("/api/gps/coverage?cell_m=100").status_code == 422

    def test_coverage_rejects_bad_session(self, client):
        assert client.get("/api/gps/coverage?session=nope").status_code == 422

    def test_coverage_is_empty_without_fixes(self, client):
        body = client.get("/api/gps/coverage").json()
        assert body["cells"] == []
        assert body["covered_m2"] == 0.0

    def test_clear_track(self, client):
        self._post_fix(client, T0, 52.52, 13.405, mowing=True)
        r = client.delete("/api/gps/track?session=all")
        assert r.status_code == 200
        assert r.json()["track_length"] == 0

    def test_delete_unknown_session(self, client):
        assert client.delete("/api/sessions/999").status_code == 404

    def test_delete_session(self, client):
        self._post_fix(client, T0, 52.52, 13.405, mowing=True)
        sid = client.get("/api/sessions").json()["sessions"][0]["id"]
        assert client.delete(f"/api/sessions/{sid}").status_code == 200
        assert client.get("/api/sessions").json()["sessions"] == []


# ─── Session history ───────────────────────────────────────────────────
class TestSessionHistory:
    MOW = int(MowerActivity.MOWING)
    CHARGING = int(MowerActivity.CHARGING)

    @staticmethod
    def _tick(isolated_store, ts, activity, battery):
        isolated_store.record_sample(ts, battery, activity, activity == int(MowerActivity.CHARGING))

    def test_empty_history(self, client):
        assert client.get("/api/sessions").json()["sessions"] == []

    def test_list_reports_rollups(self, client, isolated_store):
        t0 = T0
        for i, batt in enumerate([90, 80, 70]):
            self._tick(isolated_store, t0 + i * 60, self.MOW, batt)

        s = client.get("/api/sessions").json()["sessions"][0]
        assert s["mow_min"] == 2
        assert s["battery_start"] == 90
        assert s["battery_min"] == 70
        assert s["active"] is True

    def test_detail_returns_samples_and_events(self, client, isolated_store):
        t0 = T0
        self._tick(isolated_store, t0, self.MOW, 90)
        self._tick(isolated_store, t0 + 60, self.MOW, 85)
        self._tick(isolated_store, t0 + 120, self.CHARGING, 80)

        sid = client.get("/api/sessions").json()["sessions"][0]["id"]
        body = client.get(f"/api/sessions/{sid}").json()

        assert body["session"]["id"] == sid
        assert [s["battery"] for s in body["samples"]] == [90, 85, 80]
        assert body["samples"][0]["activity_name"] == "MOWING"
        # Only transitions become events, not every sample.
        kinds = [(e["kind"], e["detail"]) for e in body["events"]]
        assert kinds == [("activity", "MOWING"), ("activity", "CHARGING")]

    def test_detail_includes_the_plan_that_caused_the_session(self, client, isolated_store):
        t0 = T0
        isolated_store.record_plan(t0, 3600, reason="grass is due", dispatched_ts=t0 - 300)
        self._tick(isolated_store, t0, self.MOW, 90)

        sid = client.get("/api/sessions").json()["sessions"][0]["id"]
        body = client.get(f"/api/sessions/{sid}").json()
        assert body["plan"]["reason"] == "grass is due"

    def test_detail_404_for_unknown_session(self, client):
        assert client.get("/api/sessions/999").status_code == 404


# ─── Auth ─────────────────────────────────────────────────────────────────────
class TestAuth:
    @pytest.fixture
    def secured(self, web):
        web._auth_hash = bcrypt.hashpw(b"hunter2", bcrypt.gensalt())
        return TestClient(web.app)

    def test_api_requires_auth(self, secured):
        # follow_redirects off so the 401 from middleware is observed directly.
        r = secured.get("/api/connection")
        assert r.status_code == 401

    def test_page_redirects_to_login(self, secured):
        r = secured.get("/", follow_redirects=False)
        assert r.status_code == 302
        assert r.headers["location"] == "/login"

    def test_login_wrong_password(self, secured):
        r = secured.post("/login", data={"password": "nope"}, follow_redirects=False)
        assert r.status_code == 401
        assert "Incorrect password" in r.text

    def test_login_success_sets_cookie(self, web, secured):
        r = secured.post("/login", data={"password": "hunter2"}, follow_redirects=False)
        assert r.status_code == 302
        assert web._SESSION_COOKIE in r.cookies

    def test_login_rate_limited(self, web, secured):
        # Exhaust the limiter then assert the next attempt is throttled.
        web._login_attempts.clear()
        for _ in range(web._LOGIN_MAX_ATTEMPTS):
            secured.post("/login", data={"password": "x"}, follow_redirects=False)
        r = secured.post("/login", data={"password": "x"}, follow_redirects=False)
        assert r.status_code == 429


# ─── HTML page rendering (smoke) ──────────────────────────────────────────────
class TestPagesRender:
    def test_index_renders(self, client):
        r = client.get("/")
        assert r.status_code == 200
        assert "Sir Schnittalot" in r.text
        assert 'id="nav-conn-badge"' in r.text

    def test_login_page_renders(self, web):
        web._auth_hash = bcrypt.hashpw(b"pw", bcrypt.gensalt())
        c = TestClient(web.app)
        r = c.get("/login")
        assert r.status_code == 200
        assert "Sign in to continue" in r.text


# ─── Winter mode ──────────────────────────────────────────────────────────────
def _md(offset_days):
    import datetime as dt

    return (dt.date.today() + dt.timedelta(days=offset_days)).strftime("%m-%d")


# A season that contains today / does not contain today.
IN_SEASON = {"winter_earliest_md": _md(-1), "winter_exit_earliest_md": _md(2)}
OFF_SEASON = {"winter_earliest_md": _md(1), "winter_exit_earliest_md": _md(2)}


@pytest.fixture
def winter(web, monkeypatch):
    """In-memory planner config and a fake forecast; nothing touches the disk or network."""
    import datetime as dt

    from tests.test_growth import _winter_case

    store = {"enabled": False, "watchdog_enabled": False, **IN_SEASON}
    monkeypatch.setattr(web, "planner_load_config", lambda: dict(store))
    monkeypatch.setattr(web, "planner_save_config", lambda cfg: store.update(cfg))
    monkeypatch.setattr(web, "_winter_inputs", None)
    monkeypatch.setattr(web, "_winter_error", None)

    class Env:
        cfg = store
        calls = 0

        def forecast(self, past_t, future_t, future_min=None, backlog_sec=0.0):
            today = dt.date.today().isoformat()
            daily, g = _winter_case(today, past_t, future_t, future_min)

            async def fetch(_cfg):
                self.calls += 1
                return {
                    "growth": g,
                    "daily": daily,
                    "backlog_sec": backlog_sec,
                    "session_sec": 3 * 3600,
                    "checked_at": "now",
                }

            monkeypatch.setattr(web, "fetch_winter_inputs", fetch)

    return Env()


class TestWinterMode:
    def test_no_advice_in_mild_weather(self, winter, client):
        winter.forecast(past_t=16.0, future_t=16.0, future_min=5.0)
        body = client.get("/api/winter/advice").json()
        assert body["winter_mode"] is False
        assert body["advice"] is None

    def test_advises_entering_when_lawn_is_dormant(self, winter, client):
        winter.forecast(past_t=2.0, future_t=0.0)
        body = client.get("/api/winter/advice").json()
        assert body["advice"] == "enter"
        assert body["reason"]
        assert body["metrics"]["frost_days"] >= 3

    def test_forecast_failure_is_reported_not_raised(self, winter, client, web, monkeypatch):
        async def fail(_cfg):
            raise RuntimeError("offline")

        monkeypatch.setattr(web, "fetch_winter_inputs", fail)
        body = client.get("/api/winter/advice").json()
        assert body["advice"] is None
        assert body["error"] == "offline"

    def test_start_sets_flags_and_clears_sessions(self, winter, client, web):
        winter.forecast(past_t=2.0, future_t=0.0)
        web.planner._planned_sessions = [{"start_dt": None, "duration_sec": 60}]
        body = client.post("/api/winter/start").json()
        assert body["winter_mode"] is True
        assert body["since"]
        assert winter.cfg["winter_mode"] is True
        assert web.planner._planned_sessions == []
        # Already in winter mode: the entering advice no longer applies.
        assert body["advice"] is None

    def test_end_clears_flags(self, winter, client):
        winter.forecast(past_t=12.0, future_t=14.0, future_min=6.0)
        winter.cfg.update(winter_mode=True, winter_since="2026-11-15", **OFF_SEASON)
        body = client.post("/api/winter/end").json()
        assert body["winter_mode"] is False
        assert body["since"] is None
        assert winter.cfg["winter_mode"] is False

    def test_advises_ending_in_spring(self, winter, client):
        winter.forecast(past_t=12.0, future_t=14.0, future_min=6.0, backlog_sec=7200)
        winter.cfg.update(winter_mode=True, winter_since="2026-11-15", **OFF_SEASON)
        body = client.get("/api/winter/advice").json()
        assert body["advice"] == "exit"
        assert "2.0 h" in body["reason"]

    def test_snooze_hides_advice(self, winter, client):
        winter.forecast(past_t=2.0, future_t=0.0)
        assert client.get("/api/winter/advice").json()["advice"] == "enter"
        body = client.post("/api/winter/snooze").json()
        assert body["advice"] is None
        assert body["snoozed_until"] == winter.cfg["winter_snooze_until"]

    def test_starting_clears_a_snooze(self, winter, client):
        winter.forecast(past_t=2.0, future_t=0.0)
        client.post("/api/winter/snooze")
        client.post("/api/winter/start")
        assert winter.cfg["winter_snooze_until"] is None

    def test_status_shows_winter_context(self, winter, connected_client):
        winter.cfg.update(winter_mode=True, winter_since="2026-11-15")
        body = connected_client.get("/api/status").json()
        assert body["smart_context"] == "Winter mode since 2026-11-15"

    def test_config_save_preserves_winter_state(self, winter, client):
        winter.cfg.update(winter_mode=True, winter_since="2026-11-15", winter_snooze_until=None)
        r = client.post(
            "/api/planner/config",
            json={"enabled": False, "winter_earliest_md": "11-01", "winter_exit_earliest_md": "04-01"},
        )
        assert r.status_code == 200
        assert winter.cfg["winter_mode"] is True
        assert winter.cfg["winter_since"] == "2026-11-15"
        assert winter.cfg["winter_earliest_md"] == "11-01"

    @pytest.mark.parametrize("bad", ["13-01", "1-1", "10/01", "10-32"])
    def test_config_rejects_invalid_season_dates(self, winter, client, bad):
        r = client.post("/api/planner/config", json={"winter_earliest_md": bad})
        assert r.status_code == 422
