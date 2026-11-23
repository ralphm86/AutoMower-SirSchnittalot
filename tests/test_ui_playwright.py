"""
Browser acceptance tests for the server-backed five-section GUI.

These tests drive the real page in a headless browser via Playwright and mock
only the HTTP boundary. They assert the user stories and backend contracts for
Overview, Control, Planning, Activity, and Settings without using Bluetooth or
the concept's unrestricted state switcher. The uvicorn fixture isolates runtime
loops and SQLite state from the user's configuration.

Not part of the default ``pytest`` run (excluded in pyproject). Run explicitly:

    pip install -e ".[test,ui]"
    playwright install chromium
    pytest tests/test_ui_playwright.py
"""

import socket
import threading
import time

import pytest

pytest.importorskip("playwright")
import uvicorn  # noqa: E402


# ─── Live server fixture ──────────────────────────────────────────────────────
def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def live_server(tmp_path_factory):
    """Run the web shell with all runtime loops and persistence isolated."""
    import store
    import web_app

    patches = pytest.MonkeyPatch()
    test_db = tmp_path_factory.mktemp("gui") / "automower.db"
    real_init_db = store.init_db

    async def _noop():
        return None

    patches.setattr(web_app, "_auth_hash", None)
    patches.setattr(web_app, "_demo", False)
    patches.setattr(web_app, "_mqtt_cfg", None)
    patches.setattr(web_app, "_ha_bridge", None)
    patches.setattr(web_app, "_load_reconnect_state", lambda: None)
    patches.setattr(web_app, "_reconnect_loop", _noop)
    patches.setattr(web_app, "_sampler_loop", _noop)
    patches.setattr(web_app, "_idle_disconnect_loop", _noop)
    patches.setattr(web_app, "_winter_advice_loop", _noop)
    patches.setattr(web_app, "_demo_gps_loop", _noop)
    patches.setattr(web_app, "_start_ha_bridge", lambda: None)
    patches.setattr(web_app, "_winter_inputs", None)
    patches.setattr(web_app, "_winter_error", None)
    patches.setattr(
        web_app,
        "planner_load_config",
        lambda: {
            "enabled": False,
            "watchdog_enabled": False,
            "winter_mode": False,
        },
    )
    patches.setattr(web_app.watchdog, "start", lambda: None)
    patches.setattr(web_app.watchdog, "stop", _noop)
    patches.setattr(web_app.planner, "stop", _noop)
    patches.setattr(
        store,
        "init_db",
        lambda *args, **kwargs: real_init_db(test_db, import_legacy=False),
    )

    port = _free_port()
    config = uvicorn.Config(web_app.app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                break
        except OSError:
            time.sleep(0.1)
    else:
        server.should_exit = True
        thread.join(timeout=10)
        patches.undo()
        raise RuntimeError("Live server did not start in time")

    yield f"http://127.0.0.1:{port}"

    server.should_exit = True
    thread.join(timeout=10)
    patches.undo()


# ─── Route-mock helpers ───────────────────────────────────────────────────────
def _json_route(page, url_glob, payload, status=200):
    page.route(url_glob, lambda route: route.fulfill(status=status, json=payload))


def _sequence_route(page, url_glob, payloads, statuses=None):
    """Return payloads in order, then keep serving the final payload."""
    responses = list(payloads)
    codes = list(statuses or [200] * len(responses))
    position = 0

    def fulfill(route):
        nonlocal position
        index = min(position, len(responses) - 1)
        position += 1
        route.fulfill(status=codes[index], json=responses[index])

    page.route(url_glob, fulfill)


def _error_route(page, url_glob, detail="Test request failed", status=503):
    _json_route(page, url_glob, {"detail": detail}, status=status)


CONNECTED = {
    "connected": True,
    "address": "AA:BB:CC:DD:EE:FF",
    "auto_reconnect": True,
    "reconnect_target": "AA:BB:CC:DD:EE:FF",
    "saved_channel_id": 1197489078,
    "saved_pin": None,
    "server_started_at": "2026-06-25T10:00:00",
    "uptime_seconds": 60,
}

STATUS_MOWING = {
    "connected": True,
    "mower_name": "Sir Schnittalot",
    "model": "Automower 305",
    "state": "IN_OPERATION",
    "state_description": "In operation (see activity for details)",
    "activity": "mowing",
    "activity_description": "Mowing lawn",
    "mode": "AUTO",
    "control_mode": "smart",
    "smart_context": "Mowing until 12:15",
    "planner": {"state": "ok", "inhibit": None},
    "daily_target": {
        "mode": "adaptive",
        "target_s": 7200,
        "growth": {"owed_s": 7200, "threshold_s": 8280, "informational": False},
    },
    "battery_level": 80,
    "charging": False,
    "remaining_charging_min": None,
    "next_start_time": "2026-11-19T10:00:00+01:00",
    "session": {
        "active": True,
        "kind": "manual",
        "ends_at": "2026-11-18T12:15:00+01:00",
        "remaining_s": 900,
        "mowing_s": 4500,
        "charging_s": 1800,
        "elapsed_s": 6300,
    },
    "error_code": 0,
    "error_name": "NO_ERROR",
    "fetched_at": "2026-11-18T12:00:00+01:00",
    "source": "demo",
    "age_s": 1,
}

PLANNER_STATUS = {
    "state": "ok",
    "calculated_at": "2026-11-18T09:00:00+01:00",
    "fetched_at": "2026-11-18T09:00:00+01:00",
    "source": "demo",
    "age_s": 1,
    "timezone": "Europe/Berlin",
    "summary": {"session_count": 2, "cutting_s": 10800},
    "days": [
        {
            "date": "2026-11-18",
            "decision": "done",
            "sessions": [],
            "detail": {},
        },
        {
            "date": "2026-11-19",
            "decision": "session",
            "sessions": [
                {
                    "start_at": "2026-11-19T10:00:00+01:00",
                    "end_at": "2026-11-19T12:15:00+01:00",
                    "mowing_s": 5400,
                }
            ],
            "detail": {"dew_clear": "2026-11-19T10:00:00+01:00"},
        },
    ],
}

CAPABILITIES = {
    "commands": ["mow", "pause", "resume", "park", "park_home", "park_duration"],
    "max_manual_duration_min": 720,
}

WINTER_ENTER = {
    "winter_mode": False,
    "since": None,
    "advice": "enter",
    "reason": "The lawn has stopped growing.",
    "snoozed_until": None,
    "metrics": {},
    "checked_at": "2026-11-18T09:00:00+01:00",
    "error": None,
}


def _mock_app_api(
    page,
    *,
    connection=CONNECTED,
    status=STATUS_MOWING,
    planner=PLANNER_STATUS,
    winter=None,
    sessions=None,
    messages=None,
    events=None,
    schedule=None,
    watchdog=None,
    forecast=None,
):
    winter = winter or {**WINTER_ENTER, "advice": None, "reason": ""}
    sessions = sessions or {"sessions": []}
    messages = messages or {"messages": []}
    events = events or {"items": [], "next": None}
    schedule = schedule or {
        "tasks": [],
        "task_count": 0,
        "owner": "smart",
        "placeholder": True,
    }
    watchdog = watchdog or {
        "state": "monitoring",
        "last_check": "2026-11-18T11:58:00+01:00",
        "next_action_at": "2026-11-18T12:05:00+01:00",
        "mode": "smart",
    }
    forecast = forecast or {"hours": [], "source": "demo", "age_s": 1}
    routes = {
        "**/api/connection": connection,
        "**/api/status": status,
        "**/api/planner/status": planner,
        "**/api/planner/config": {"enabled": True, "adaptive_enabled": True},
        "**/api/planner/forecast": forecast,
        "**/api/watchdog/status": watchdog,
        "**/api/capabilities": CAPABILITIES,
        "**/api/schedule": schedule,
        "**/api/schedule/backup": {
            "backup_id": "b-1",
            "taken_at": "2026-11-01T08:00:00+01:00",
            "task_count": 2,
        },
        "**/api/sessions*": sessions,
        "**/api/messages*": messages,
        "**/api/events*": events,
        "**/api/winter/advice": winter,
        "**/api/gps/**": {"track": []},
    }
    for pattern, payload in routes.items():
        _json_route(page, pattern, payload)


# ─── Tests ────────────────────────────────────────────────────────────────────
GUI_SECTIONS = (
    ("Overview", "overview"),
    ("Control", "control"),
    ("Planning", "planning"),
    ("Activity", "activity"),
    ("Settings", "settings"),
)


def _open_gui(page, live_server, route="overview", **api):
    _mock_app_api(page, **api)
    page.goto(f"{live_server}/#{route}")
    page.locator("body").wait_for(state="visible", timeout=5000)


def _main_nav(page):
    nav = page.get_by_role("navigation", name="Main navigation")
    nav.wait_for(state="visible", timeout=5000)
    return nav


def _visible_section(page, route):
    section = page.locator(f"#{route}:not([hidden])")
    section.wait_for(state="visible", timeout=5000)
    return section


class TestShell:
    def test_isolated_server_loads_the_app_shell(self, page, live_server):
        response = page.goto(live_server)
        assert response is not None
        assert response.ok
        assert "Sir Schnittalot" in page.title()

    def test_five_sections_are_hash_backed(self, page, live_server):
        _open_gui(page, live_server)
        nav = _main_nav(page)

        for label, route in GUI_SECTIONS:
            link = nav.get_by_role("link", name=label, exact=True)
            link.wait_for(state="visible", timeout=5000)

        nav.get_by_role("link", name="Control", exact=True).click()
        _visible_section(page, "control")
        assert page.url.endswith("#control")

    def test_direct_link_reload_and_history_keep_destination(self, page, live_server):
        _open_gui(page, live_server, "activity/sessions")
        _visible_section(page, "activity")
        page.reload()
        _visible_section(page, "activity")

        nav = _main_nav(page)
        nav.get_by_role("link", name="Planning", exact=True).click()
        _visible_section(page, "planning")
        nav.get_by_role("link", name="Control", exact=True).click()
        _visible_section(page, "control")
        page.go_back()
        _visible_section(page, "planning")
        assert page.url.endswith("#planning")

    def test_default_route_is_overview(self, page, live_server):
        _open_gui(page, live_server, route="")
        _visible_section(page, "overview")
        assert _main_nav(page).get_by_role("link", name="Overview").get_attribute(
            "aria-current"
        ) == "page"

    def test_demo_marker_persists_across_every_section(self, page, live_server):
        _open_gui(page, live_server)
        nav = _main_nav(page)

        for label, route in GUI_SECTIONS:
            nav.get_by_role("link", name=label, exact=True).click()
            _visible_section(page, route)
            page.get_by_label("Global status").get_by_text(
                "DEMO", exact=False
            ).wait_for(state="visible", timeout=5000)


class TestTruthfulOverview:
    def test_active_session_is_shown_before_the_next_plan(self, page, live_server):
        _open_gui(page, live_server)
        overview = _visible_section(page, "overview")

        overview.get_by_role("heading", name="Mowing", exact=True).wait_for(
            state="visible", timeout=5000
        )
        assert "Until 12:15" in overview.inner_text()
        assert "15 min remaining" in overview.inner_text()
        assert "Mowing so far" in overview.inner_text()
        assert "elapsed including charging" in overview.inner_text()

    def test_paused_mower_is_never_labelled_parked(self, page, live_server):
        paused = {
            **STATUS_MOWING,
            "activity": "paused",
            "planner": {"state": "ok", "inhibit": "paused_by_user"},
            "session": None,
        }
        _open_gui(page, live_server, status=paused)
        band = _visible_section(page, "overview").locator(".status-band")

        band.get_by_role("heading", name="Paused in the garden", exact=True).wait_for(
            state="visible", timeout=5000
        )
        assert "Stopped where it is" in band.inner_text()
        assert "Parked at home" not in band.inner_text()
        assert "planner is paused" in band.inner_text().lower()

    def test_cached_status_is_labelled_last_known(self, page, live_server):
        stale = {
            **STATUS_MOWING,
            "connected": False,
            "source": "cached",
            "age_s": 300,
        }
        disconnected = {
            **CONNECTED,
            "connected": False,
            "address": "AA:BB:CC:DD:EE:FF",
        }
        _open_gui(page, live_server, connection=disconnected, status=stale)
        overview = _visible_section(page, "overview")
        overview.get_by_text("Last known data", exact=False).first.wait_for(
            state="visible", timeout=5000
        )
        assert "Updated just now" not in overview.inner_text()


class TestCommands:
    def test_invalid_duration_never_submits_a_command(self, page, live_server):
        submitted = []

        def record(route):
            submitted.append(route.request.post_data_json)
            route.fulfill(status=202, json={"command_id": "c-1", "state": "sent"})

        page.route("**/api/command/mow", record)
        _open_gui(page, live_server, "control")
        control = _visible_section(page, "control")
        duration = control.get_by_label("Duration (minutes)")
        duration.fill("14")
        control.get_by_role("button", name="Start mowing", exact=True).click()

        control.get_by_text("15 to 720", exact=False).wait_for(timeout=5000)
        assert duration.get_attribute("aria-invalid") == "true"
        assert submitted == []

    def test_command_progress_reaches_observed_without_duplicate_submit(
        self, page, live_server
    ):
        submitted = []

        def record(route):
            submitted.append(route.request.post_data_json)
            route.fulfill(status=202, json={"command_id": "c-1", "state": "sent"})

        page.route("**/api/command/mow", record)
        _sequence_route(
            page,
            "**/api/commands/c-1",
            [
                {
                    "command_id": "c-1",
                    "command": "mow",
                    "state": "accepted",
                    "expected": {"activity": "mowing"},
                },
                {
                    "command_id": "c-1",
                    "command": "mow",
                    "state": "observed",
                    "expected": {"activity": "mowing"},
                },
            ],
        )
        _open_gui(page, live_server, "control")
        control = _visible_section(page, "control")
        control.get_by_label("Duration (minutes)").fill("60")
        button = control.get_by_role("button", name="Start mowing", exact=True)
        button.click()

        assert button.is_disabled()
        assert len(submitted) == 1
        status = control.get_by_role("region", name="Command status")
        status.get_by_text("Accepted by the mower", exact=False).wait_for(timeout=5000)
        status.get_by_text("Confirmed by the mower", exact=False).wait_for(timeout=5000)
        assert len(submitted) == 1

    def test_rejected_command_preserves_duration_and_explains_retry(
        self, page, live_server
    ):
        _error_route(
            page,
            "**/api/command/mow",
            detail="The mower is busy; nothing changed.",
            status=503,
        )
        _open_gui(page, live_server, "control")
        control = _visible_section(page, "control")
        duration = control.get_by_label("Duration (minutes)")
        duration.fill("90")
        control.get_by_role("button", name="Start mowing", exact=True).click()

        alert = control.get_by_role("alert")
        alert.get_by_text("mower is busy", exact=False).wait_for(timeout=5000)
        assert duration.input_value() == "90"
        alert.get_by_role("button", name="Retry with the same settings").wait_for(
            timeout=5000
        )

    def test_skip_is_unavailable_without_an_active_session(self, page, live_server):
        parked = {
            **STATUS_MOWING,
            "activity": "parked",
            "session": None,
            "planner": {"state": "ok", "inhibit": None},
        }
        _open_gui(page, live_server, "control", status=parked)
        control = _visible_section(page, "control")

        button = control.get_by_role("button", name="Skip session", exact=True)
        assert button.is_disabled()
        control.get_by_text("No active session to skip", exact=False).wait_for(
            timeout=5000
        )


class TestPlanning:
    def test_zero_session_plan_is_successful_but_not_empty_success(
        self, page, live_server
    ):
        zero_plan = {
            **PLANNER_STATUS,
            "state": "zero_sessions",
            "summary": {"session_count": 0, "cutting_s": 0},
            "days": [
                {
                    "date": "2026-11-18",
                    "decision": "cold",
                    "sessions": [],
                    "detail": {"temp_c": 1.2, "min_temp_c": 5.0},
                },
                {
                    "date": "2026-11-19",
                    "decision": "no_window",
                    "sessions": [],
                    "detail": {"available_windows": 0},
                },
            ],
        }
        _open_gui(page, live_server, "planning", planner=zero_plan)
        planning = _visible_section(page, "planning")

        planning.get_by_text("Too cold", exact=False).wait_for(timeout=5000)
        planning.get_by_text("No window", exact=False).wait_for(timeout=5000)
        planning.get_by_text("no suitable sessions", exact=False).wait_for(timeout=5000)
        assert "2 upcoming sessions" not in planning.inner_text()

    def test_adaptive_growth_replaces_the_daily_target(self, page, live_server):
        _open_gui(page, live_server)
        overview = _visible_section(page, "overview")

        overview.get_by_role("heading", name="Mowing owed", exact=True).wait_for(
            timeout=5000
        )
        assert "Session due at" in overview.inner_text()
        assert "Daily target of" not in overview.inner_text()

    def test_smart_mode_locks_firmware_calendar_edits(self, page, live_server):
        _open_gui(page, live_server, "planning/calendar")
        planning = _visible_section(page, "planning")

        planning.get_by_text("planner owns the firmware calendar", exact=False).wait_for(
            timeout=5000
        )
        planning.get_by_text("placeholder task", exact=False).wait_for(timeout=5000)
        save = planning.get_by_role("button", name="Save calendar", exact=False)
        if save.count():
            assert save.is_disabled()

    def test_failed_mode_transition_names_step_and_keeps_recovery(
        self, page, live_server
    ):
        failure = {
            "failed_step": "write",
            "recoverable": True,
            "backup_id": "b-1",
        }

        def fail_transition(route):
            if route.request.method == "POST":
                route.fulfill(status=409, json=failure)
            else:
                route.fulfill(json={"enabled": True, "adaptive_enabled": True})

        _open_gui(page, live_server, "planning")
        page.route("**/api/planner/config", fail_transition)
        page.route("**/api/schedule/restore", lambda route: route.fulfill(status=409, json=failure))
        planning = _visible_section(page, "planning")
        planning.get_by_role("button", name="Switch to Classic", exact=False).click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_text("recoverable copy", exact=False).wait_for(timeout=5000)
        dialog.get_by_role("button", name="Switch to Classic", exact=True).click()

        dialog.get_by_text("write", exact=False).wait_for(timeout=5000)
        dialog.get_by_text("failed", exact=False).wait_for(timeout=5000)
        dialog.get_by_role("button", name="Restore my saved calendar", exact=False).wait_for(
            timeout=5000
        )


class TestActivity:
    def test_session_list_labels_cutting_elapsed_and_record_state(
        self, page, live_server
    ):
        sessions = {
            "sessions": [
                {
                    "id": 7,
                    "started_at": "2026-11-18T10:50:00+01:00",
                    "ended_at": "2026-11-18T13:10:00+01:00",
                    "mowing_s": 5400,
                    "charging_s": 2700,
                    "searching_s": 300,
                    "elapsed_s": 8400,
                    "record_state": "complete",
                    "end_reason": "session complete",
                }
            ]
        }
        _open_gui(page, live_server, "activity/sessions", sessions=sessions)
        activity = _visible_section(page, "activity")

        activity.get_by_text("1 h 30 m", exact=False).wait_for(timeout=5000)
        activity.get_by_text("2 h 20 m elapsed", exact=False).wait_for(timeout=5000)
        activity.get_by_text("Complete", exact=False).wait_for(timeout=5000)

    def test_unsupported_event_history_is_hidden(self, page, live_server):
        _open_gui(page, live_server, "activity", events={"supported": False})
        activity = _visible_section(page, "activity")
        assert activity.get_by_role("tab", name="Events", exact=True).count() == 0

    def test_active_error_links_to_message_evidence(self, page, live_server):
        status = {
            **STATUS_MOWING,
            "activity": "error",
            "error_code": 12,
            "error_name": "Outside work area",
            "session": None,
        }
        _open_gui(page, live_server, status=status)
        overview = _visible_section(page, "overview")
        overview.get_by_role("link", name="View error details", exact=False).click()
        _visible_section(page, "activity")
        assert page.url.endswith("#activity/messages")


class TestWinterMode:
    def test_entering_winter_mode_requires_an_explanation_and_confirmation(
        self, page, live_server
    ):
        start_requests = []
        _open_gui(page, live_server, winter=WINTER_ENTER)
        page.on(
            "request",
            lambda request: start_requests.append(request.url)
            if request.method == "POST" and request.url.endswith("/api/winter/start")
            else None,
        )
        _visible_section(page, "overview").get_by_role(
            "button", name="Review and enter winter mode", exact=False
        ).click()
        dialog = page.get_by_role("dialog")

        dialog.get_by_text("does not stop or store the mower", exact=False).wait_for(
            timeout=5000
        )
        dialog.get_by_text("firmware calendar", exact=False).wait_for(timeout=5000)
        assert start_requests == []
        dialog.get_by_role("button", name="Enter winter mode", exact=True).wait_for(
            timeout=5000
        )

    def test_active_winter_mode_is_global_and_truthful(self, page, live_server):
        active = {
            **WINTER_ENTER,
            "winter_mode": True,
            "since": "2026-11-15",
            "advice": None,
        }
        disconnected = {**CONNECTED, "connected": False}
        cached = {**STATUS_MOWING, "connected": False, "source": "cached"}
        _open_gui(
            page,
            live_server,
            connection=disconnected,
            status=cached,
            winter=active,
        )
        overview = _visible_section(page, "overview")

        overview.get_by_role("heading", name="Winter mode", exact=True).wait_for(
            timeout=5000
        )
        assert "does not stop or store the mower" in overview.inner_text().lower()
        page.get_by_label("Global status").get_by_text("Winter mode", exact=True).wait_for(
            timeout=5000
        )

    def test_reduced_motion_suppresses_snow(self, page, live_server):
        page.emulate_media(reduced_motion="reduce")
        active = {
            **WINTER_ENTER,
            "winter_mode": True,
            "since": "2026-11-15",
            "advice": None,
        }
        _open_gui(page, live_server, winter=active)
        _visible_section(page, "overview")
        assert page.locator("#snow i").count() == 0


class TestSettings:
    def test_failed_connection_keeps_address_and_clears_pin(self, page, live_server):
        _error_route(page, "**/api/connect", detail="Pairing was rejected.", status=503)
        disconnected = {**CONNECTED, "connected": False, "address": None}
        _open_gui(page, live_server, "settings", connection=disconnected)
        settings = _visible_section(page, "settings")
        address = settings.get_by_label("Bluetooth address")
        pin = settings.get_by_label("PIN (optional)")
        address.fill("AA:BB:CC:11:22:33")
        pin.fill("1234")
        settings.get_by_role("button", name="Connect", exact=True).click()

        settings.get_by_role("alert").get_by_text("Pairing was rejected", exact=False).wait_for(
            timeout=5000
        )
        assert address.input_value() == "AA:BB:CC:11:22:33"
        assert pin.input_value() == ""
        assert "1234" not in settings.inner_text()


@pytest.mark.parametrize("width", [360, 390, 768, 1280])
class TestResponsiveNavigation:
    def test_every_section_avoids_page_horizontal_scroll(self, page, live_server, width):
        page.set_viewport_size({"width": width, "height": 900})
        _open_gui(page, live_server)
        nav = _main_nav(page)

        for label, route in GUI_SECTIONS:
            nav.get_by_role("link", name=label, exact=True).click()
            _visible_section(page, route)
            dimensions = page.evaluate(
                """() => ({
                    scroll: document.documentElement.scrollWidth,
                    client: document.documentElement.clientWidth
                })"""
            )
            assert dimensions["scroll"] <= dimensions["client"] + 1

    def test_navigation_links_keep_44px_touch_targets(self, page, live_server, width):
        page.set_viewport_size({"width": width, "height": 900})
        _open_gui(page, live_server)
        sizes = _main_nav(page).locator("a").evaluate_all(
            """links => links.map(link => {
                const box = link.getBoundingClientRect();
                return { width: box.width, height: box.height };
            })"""
        )
        assert len(sizes) == 5
        assert all(size["width"] >= 44 and size["height"] >= 44 for size in sizes)

    def test_keyboard_focus_is_visible_on_primary_navigation(
        self, page, live_server, width
    ):
        page.set_viewport_size({"width": width, "height": 900})
        _open_gui(page, live_server)
        link = _main_nav(page).get_by_role("link", name="Control", exact=True)
        link.focus()
        outline = link.evaluate(
            """element => {
                const style = getComputedStyle(element);
                return `${style.outlineStyle} ${style.outlineWidth}`;
            }"""
        )
        assert outline.startswith("solid ") and not outline.endswith(" 0px")
