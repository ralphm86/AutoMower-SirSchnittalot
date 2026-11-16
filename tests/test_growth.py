"""Tests for the lawn growth model and adaptive scheduling."""

import datetime as dt

import pytest

import growth
from planner import plan_schedule, parse_daily
from tests.test_planner import _cfg, _good_forecast


def _day(temp=18.0, precip=0.0, et0=3.0):
    return {"temp_mean_c": temp, "precip_mm": precip, "et0_mm": et0}


def _dates(n, start=None):
    start = start or dt.date.today() - dt.timedelta(days=14)
    return [(start + dt.timedelta(days=i)).isoformat() for i in range(n)]


class TestGrowthModel:
    @pytest.mark.parametrize(
        "t,expected", [(0, 0.0), (10, 0.5), (20, 1.0), (35, 0.0), (40, 0.0)]
    )
    def test_temp_factor(self, t, expected):
        assert growth.temp_factor(t) == pytest.approx(expected)

    def test_drought_suppresses_growth_then_rain_restores_it(self):
        dry = {d: _day(precip=0.0, et0=5.0) for d in _dates(20)}
        dry_growth = growth.simulate_growth(dry)
        last_dry = dry_growth[max(dry_growth)]["growth"]
        assert last_dry < 0.2

        wet = dict(dry)
        wet[max(wet)] = _day(precip=40.0, et0=1.0)
        assert growth.simulate_growth(wet)[max(wet)]["growth"] == pytest.approx(1.0)

    def test_missing_temperature_day_is_skipped(self):
        days = {"2026-06-01": {"temp_mean_c": None, "precip_mm": 0, "et0_mm": 0}}
        assert growth.simulate_growth(days) == {}

    def test_backlog_pays_off_with_mowing(self):
        g = {d: {"growth": 1.0} for d in _dates(4, dt.date(2026, 6, 1))}
        per_day = 1.5 * 3600
        cap = 6 * 3600
        none_mowed = growth.carried_backlog_sec(g, {}, "2026-06-05", per_day, cap)
        assert none_mowed == pytest.approx(4 * per_day)
        mowed = growth.carried_backlog_sec(
            g, {"2026-06-02": 3 * 3600}, "2026-06-05", per_day, cap
        )
        assert mowed == pytest.approx(per_day * 4 - 3 * 3600)

    def test_backlog_is_capped(self):
        g = {d: {"growth": 1.0} for d in _dates(10, dt.date(2026, 6, 1))}
        cap = 6 * 3600
        assert growth.carried_backlog_sec(g, {}, "2026-06-11", 5400, cap) == cap


class TestParseDaily:
    def test_growth_inputs_parsed(self):
        data = {
            "daily": {
                "time": ["2026-06-01"],
                "temperature_2m_mean": [17.5],
                "precipitation_sum": [2.0],
                "et0_fao_evapotranspiration": [None],
            },
            "utc_offset_seconds": 0,
        }
        day = parse_daily(data)["2026-06-01"]
        assert day["temp_mean_c"] == 17.5
        assert day["precip_mm"] == 2.0
        assert day["et0_mm"] is None

    def test_winter_inputs_parsed(self):
        data = {
            "daily": {
                "time": ["2026-01-10", "2026-01-11"],
                "temperature_2m_mean": [-1.0, 2.0],
                "temperature_2m_min": [-4.5, None],
                "snowfall_sum": [1.2, 0.0],
            },
            "utc_offset_seconds": 0,
        }
        days = parse_daily(data)
        assert days["2026-01-10"]["temp_min_c"] == -4.5
        assert days["2026-01-10"]["snow_cm"] == 1.2
        assert days["2026-01-11"]["temp_min_c"] is None


def _winter_case(today, past_t, future_t, future_min=None, snow=0.0):
    """Daily weather 7 days back and 7 ahead with constant temperatures."""
    day0 = dt.date.fromisoformat(today)
    daily = {}
    for i in range(-7, 7):
        t = past_t if i < 0 else future_t
        daily[(day0 + dt.timedelta(days=i)).isoformat()] = {
            "temp_mean_c": t,
            "temp_min_c": t - 3.0 if future_min is None or i < 0 else future_min,
            "snow_cm": snow if i >= 0 else 0.0,
            "precip_mm": 0.0,
            "et0_mm": 0.5,
        }
    return daily, growth.simulate_growth(daily)


class TestWinterAdvice:
    SESSION = 3 * 3600

    def _advice(self, today, winter, daily, g, backlog=0.0, **kw):
        return growth.winter_advice(g, daily, today, winter, backlog, self.SESSION, **kw)

    def test_enter_when_dormant_and_frost_ahead(self):
        daily, g = _winter_case("2026-11-15", past_t=2.0, future_t=0.0)
        out = self._advice("2026-11-15", False, daily, g)
        assert out["action"] == "enter"
        assert out["metrics"]["frost_days"] == 7
        assert out["reason"]

    def test_no_enter_while_lawn_still_grows(self):
        daily, g = _winter_case("2026-11-15", past_t=16.0, future_t=16.0, future_min=2.0)
        assert self._advice("2026-11-15", False, daily, g)["action"] is None

    def test_no_enter_without_frost_ahead(self):
        daily, g = _winter_case("2026-11-15", past_t=2.0, future_t=3.0, future_min=1.0)
        assert self._advice("2026-11-15", False, daily, g)["action"] is None

    def test_snow_counts_as_frost(self):
        daily, g = _winter_case("2026-11-15", past_t=2.0, future_t=3.0, future_min=1.0, snow=2.0)
        assert self._advice("2026-11-15", False, daily, g)["action"] == "enter"

    def test_no_enter_with_large_backlog(self):
        daily, g = _winter_case("2026-11-15", past_t=2.0, future_t=0.0)
        out = self._advice("2026-11-15", False, daily, g, backlog=self.SESSION)
        assert out["action"] is None

    def test_no_enter_outside_season(self):
        daily, g = _winter_case("2026-06-15", past_t=2.0, future_t=0.0)
        assert self._advice("2026-06-15", False, daily, g)["action"] is None

    def test_season_wraps_over_new_year(self):
        daily, g = _winter_case("2027-01-20", past_t=2.0, future_t=0.0)
        assert self._advice("2027-01-20", False, daily, g)["action"] == "enter"

    def test_exit_when_spring_has_come(self):
        daily, g = _winter_case("2026-04-10", past_t=12.0, future_t=14.0, future_min=6.0)
        out = self._advice("2026-04-10", True, daily, g, backlog=2 * 3600)
        assert out["action"] == "exit"
        assert "2.0 h" in out["reason"]

    def test_no_exit_while_still_in_winter_season(self):
        daily, g = _winter_case("2027-01-20", past_t=12.0, future_t=14.0, future_min=6.0)
        assert self._advice("2027-01-20", True, daily, g)["action"] is None

    def test_no_exit_when_frost_returns(self):
        daily, g = _winter_case("2026-04-10", past_t=12.0, future_t=14.0, future_min=-1.0)
        assert self._advice("2026-04-10", True, daily, g)["action"] is None

    def test_no_exit_when_still_cold(self):
        daily, g = _winter_case("2026-04-10", past_t=6.0, future_t=7.0, future_min=3.0)
        assert self._advice("2026-04-10", True, daily, g)["action"] is None

    def test_conditions_for_entering_never_end_winter_mode(self):
        daily, g = _winter_case("2026-11-15", past_t=2.0, future_t=0.0)
        assert self._advice("2026-11-15", True, daily, g)["action"] is None

    def test_missing_forecast_gives_no_advice(self):
        assert self._advice("2026-11-15", False, {}, {})["action"] is None
        assert self._advice("2026-04-10", True, {}, {})["action"] is None

    def test_custom_season_dates(self):
        daily, g = _winter_case("2026-11-15", past_t=2.0, future_t=0.0)
        out = self._advice("2026-11-15", False, daily, g, enter_md="12-01", exit_md="02-01")
        assert out["action"] is None


def _growth_input(g, carry_h=0.0, session_h=3.0, interval=2):
    per_day, trigger, cap = growth.demand_params(session_h, interval)
    today = dt.date.today()
    return {
        "daily": {
            (today + dt.timedelta(days=i)).isoformat(): {"growth": g} for i in range(7)
        },
        "carry_sec": carry_h * 3600,
        "per_day_sec": per_day,
        "trigger_sec": trigger,
        "cap_sec": cap,
    }


class TestAdaptiveSchedule:
    def test_peak_growth_mows_every_other_day(self):
        sessions, log = plan_schedule(
            _cfg(max_duration_minutes=240), _good_forecast(), growth=_growth_input(1.0)
        )
        mowed = [e["date"] for e in log if e["status"] == "scheduled"]
        assert 2 <= len(mowed) <= 4
        assert any(e["status"] == "growth" for e in log)

    def test_dormant_lawn_is_not_mowed(self):
        sessions, log = plan_schedule(
            _cfg(), _good_forecast(), growth=_growth_input(0.05)
        )
        assert sessions == []
        assert all(e["status"] == "growth" for e in log)

    def test_large_backlog_is_mowed_and_never_over_scheduled(self):
        sessions, _ = plan_schedule(
            _cfg(max_duration_minutes=480),
            _good_forecast(),
            growth=_growth_input(0.0, carry_h=4.0),
        )
        first_day = sessions[0]["date"]
        # Today's remaining window may be shorter than the backlog, so only bound above.
        total = sum(s["duration_sec"] for s in sessions if s["date"] == first_day)
        assert 0 < total <= 4 * 3600 + 60

    def test_fixed_rules_ignored_when_adaptive(self):
        # mowing_interval_days=5 would block day 2; growth backlog decides instead.
        sessions, log = plan_schedule(
            _cfg(mowing_interval_days=5, max_duration_minutes=240),
            _good_forecast(),
            seeded_last_mow_date=dt.date.today(),
            growth=_growth_input(1.0, carry_h=3.0),
        )
        assert not any(e["status"] == "interval" for e in log)
        assert sessions
