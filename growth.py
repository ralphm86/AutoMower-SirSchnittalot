"""
Lawn growth model for the adaptive mowing planner.

Daily weather is turned into a growth index (0 = dormant, 1 = peak growth)
from mean temperature and a simple soil-water bucket.  Growth accumulates as
a mowing "backlog" (seconds of mowing owed) which actual mowing pays off.
"""

import datetime as dt

# Mow once the backlog reaches this share of a full peak-growth session.
TRIGGER_FRACTION = 0.75
# Backlog ceiling, as a multiple of a full session, so long gaps don't snowball.
CAP_FRACTION = 2.0

_KC = 0.8            # crop coefficient applied to reference evapotranspiration
_START_FILL = 0.6    # assumed soil fill at the start of the simulated history


def temp_factor(t_c: float) -> float:
    """Cool-season grass: dormant below 5 °C and above 35 °C, optimum 15–24 °C."""
    if t_c <= 5.0 or t_c >= 35.0:
        return 0.0
    if t_c < 15.0:
        return (t_c - 5.0) / 10.0
    if t_c <= 24.0:
        return 1.0
    return (35.0 - t_c) / 11.0


def water_factor(soil_mm: float, capacity_mm: float) -> float:
    """Growth is unrestricted while the bucket is at least half full."""
    return max(0.05, min(1.0, soil_mm / (0.5 * capacity_mm)))


def simulate_growth(daily: dict[str, dict], capacity_mm: float = 40.0) -> dict[str, dict]:
    """
    Run the soil-water bucket over *daily* (``parse_daily`` output, past days
    first) and return {date: {growth, temp_factor, water_factor, soil_mm}}.
    Days without a mean temperature are skipped.
    """
    capacity_mm = max(1.0, capacity_mm)
    soil = _START_FILL * capacity_mm
    result: dict[str, dict] = {}
    for date in sorted(daily):
        d = daily[date]
        soil += (d.get("precip_mm") or 0.0) - _KC * (d.get("et0_mm") or 0.0)
        soil = max(0.0, min(capacity_mm, soil))
        t = d.get("temp_mean_c")
        if t is None:
            continue
        tf = temp_factor(t)
        wf = water_factor(soil, capacity_mm)
        result[date] = {
            "growth": round(tf * wf, 3),
            "temp_factor": round(tf, 3),
            "water_factor": round(wf, 3),
            "soil_mm": round(soil, 1),
        }
    return result


def demand_params(session_hours: float, peak_interval_days: int) -> tuple[float, float, float]:
    """Return (backlog_sec_per_day_at_peak, trigger_sec, cap_sec)."""
    session_sec = max(0.0, session_hours) * 3600.0
    per_day = session_sec / max(1, peak_interval_days)
    return per_day, TRIGGER_FRACTION * session_sec, CAP_FRACTION * session_sec


def carried_backlog_sec(
    growth: dict[str, dict],
    mowed_sec_by_date: dict[str, float],
    today_iso: str,
    per_day_sec: float,
    cap_sec: float,
) -> float:
    """Backlog at the start of today: past growth minus past mowing, never below 0."""
    backlog = 0.0
    for date in sorted(growth):
        if date >= today_iso:
            break
        backlog += growth[date]["growth"] * per_day_sec - mowed_sec_by_date.get(date, 0.0)
        backlog = max(0.0, min(cap_sec, backlog))
    return backlog


# ─── Winter mode advice ───────────────────────────────────────────────────────
# Enter and exit thresholds differ on purpose so the advice cannot flip-flop.
WINTER_ENTER_GROWTH = 0.1       # mean growth index below which the lawn counts as dormant
WINTER_EXIT_GROWTH = 0.3        # mean forecast growth index above which it is growing again
WINTER_EXIT_TEMP_C = 8.0        # mean forecast temperature needed to end winter mode
WINTER_ENTER_FROST_DAYS = 3     # forecast frost/snow days (of the next 7) that support entering
WINTER_BACKLOG_FRACTION = 0.1   # max mowing still owed, as a share of one session, to enter
_WINTER_LOOKBACK_DAYS = 7
_WINTER_LOOKAHEAD_DAYS = 7
_WINTER_EXIT_DAYS = 5


def _in_winter_season(month_day: str, enter_md: str, exit_md: str) -> bool:
    """True when *month_day* ("MM-DD") lies in [enter_md, exit_md), wrapping over New Year."""
    if enter_md <= exit_md:
        return enter_md <= month_day < exit_md
    return month_day >= enter_md or month_day < exit_md


def _mean(values: list[float]) -> float:
    return sum(values) / len(values)


def winter_advice(
    growth: dict[str, dict],
    daily: dict[str, dict],
    today_iso: str,
    winter_mode: bool,
    backlog_sec: float,
    session_sec: float,
    enter_md: str = "10-01",
    exit_md: str = "03-01",
) -> dict:
    """
    Suggest entering or leaving winter mode from the growth model and forecast.

    *growth* is ``simulate_growth`` output and *daily* is ``parse_daily`` output.
    Entering is only suggested inside the [enter_md, exit_md) season and leaving
    only outside it, so a mild spell in midwinter never ends winter mode.
    Returns {"action": "enter" | "exit" | None, "reason": str, "metrics": dict}.
    """
    today = dt.date.fromisoformat(today_iso)

    def days(first: int, last: int) -> list[str]:
        return [(today + dt.timedelta(days=i)).isoformat() for i in range(first, last)]

    def freezing(date: str) -> bool:
        d = daily.get(date, {})
        t_min, snow = d.get("temp_min_c"), d.get("snow_cm")
        return (t_min is not None and t_min < 0.0) or bool(snow and snow > 0.0)

    window = [d for d in days(-_WINTER_LOOKBACK_DAYS, _WINTER_LOOKAHEAD_DAYS) if d in growth]
    ahead = days(0, _WINTER_LOOKAHEAD_DAYS)
    exit_days = [d for d in days(0, _WINTER_EXIT_DAYS) if d in growth and d in daily]

    metrics: dict = {
        "growth_mean": round(_mean([growth[d]["growth"] for d in window]), 3) if window else None,
        "frost_days": sum(freezing(d) for d in ahead),
        "backlog_h": round(backlog_sec / 3600, 2),
    }
    if len(exit_days) == _WINTER_EXIT_DAYS:
        metrics["growth_mean_ahead"] = round(_mean([growth[d]["growth"] for d in exit_days]), 3)
        temps = [daily[d].get("temp_mean_c") for d in exit_days]
        if all(t is not None for t in temps):
            metrics["temp_mean_ahead_c"] = round(_mean(temps), 1)
        metrics["frost_ahead"] = any(freezing(d) for d in exit_days)

    none = {"action": None, "reason": "", "metrics": metrics}
    in_season = _in_winter_season(today_iso[5:], enter_md, exit_md)

    if not winter_mode:
        if (
            not in_season
            or len(window) < _WINTER_LOOKBACK_DAYS + _WINTER_LOOKAHEAD_DAYS
            or metrics["growth_mean"] >= WINTER_ENTER_GROWTH
            or metrics["frost_days"] < WINTER_ENTER_FROST_DAYS
            or backlog_sec > WINTER_BACKLOG_FRACTION * session_sec
        ):
            return none
        return {
            "action": "enter",
            "reason": (
                f"The lawn has stopped growing (growth index {metrics['growth_mean']:.2f}) "
                f"and {metrics['frost_days']} of the next {_WINTER_LOOKAHEAD_DAYS} days "
                "bring frost or snow. Time to store the mower for winter."
            ),
            "metrics": metrics,
        }

    if (
        in_season
        or "temp_mean_ahead_c" not in metrics
        or metrics["growth_mean_ahead"] <= WINTER_EXIT_GROWTH
        or metrics["temp_mean_ahead_c"] <= WINTER_EXIT_TEMP_C
        or metrics["frost_ahead"]
    ):
        return none
    return {
        "action": "exit",
        "reason": (
            f"The lawn is growing again (growth index {metrics['growth_mean_ahead']:.2f}, "
            f"{metrics['temp_mean_ahead_c']:.1f} °C on average, no frost for the next "
            f"{_WINTER_EXIT_DAYS} days). About {metrics['backlog_h']:.1f} h of mowing is owed. "
            "Time to take the mower out of the cellar."
        ),
        "metrics": metrics,
    }
