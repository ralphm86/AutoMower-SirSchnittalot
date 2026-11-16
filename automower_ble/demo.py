"""
Simulated Automower for demos: a drop-in replacement for `Mower` that needs no
Bluetooth hardware.

Only the transport is replaced. `command()` answers the protocol commands from a
small state machine, so every high-level `Mower` method (override, park, pause,
schedule transactions, ...) runs the same command sequences it would on a real
mower. The simulation advances lazily on each call and via `advance()`.

Two clocks are used: positions and travel run in real time, while battery and
lifetime counters run `speed` times faster so a full mow/charge cycle fits into a
presentation. Overrides and the weekly schedule use wall-clock time.
"""

import calendar
import datetime as dt
import logging
import math
import random
import time

from automower_ble.error_codes import ErrorCodes
from automower_ble.mower import Mower
from automower_ble.protocol import (
    ModeOfOperation,
    MowerActivity,
    MowerState,
    OverrideAction,
    ResponseResult,
)

logger = logging.getLogger(__name__)

DEMO_ADDRESS = "00:DE:30:00:00:01"

LOW_BATTERY_PCT = 20.0        # head home below this
RESUME_BATTERY_PCT = 95.0     # leave the station again at this level
DISCHARGE_PCT_PER_H = 35.0    # simulated hours
SEARCH_DISCHARGE_PCT_PER_H = 25.0
CHARGE_PCT_PER_H = 60.0

GROUND_SPEED_MS = 0.5
LAWN_WIDTH_M = 24.0
LAWN_HEIGHT_M = 16.0
LANE_SPACING_M = 0.5
DOCK_M = (-2.0, 0.0)          # charging station, relative to the lawn origin

_COLLISION_EVERY_S = 600.0    # simulated seconds of mowing per bump
_STEP_S = 1.0                 # real seconds per simulation step
_MAX_CATCHUP_S = 1800.0       # cap on one catch-up after a long pause in polling
_M_PER_DEG_LAT = 111_320.0
_FAR_FUTURE_S = 365 * 86400

# (start seconds after midnight, duration seconds, Mon..Sun)
_DEFAULT_TASKS = [
    {"start": 9 * 3600, "duration": 3 * 3600, "days": [1, 1, 1, 1, 1, 0, 0]},
    {"start": 10 * 3600, "duration": 2 * 3600, "days": [0, 0, 0, 0, 0, 1, 0]},
]

# (days ago, error code) shown in the message log
_DEFAULT_MESSAGES = [
    (1, ErrorCodes.TRAPPED),
    (3, ErrorCodes.OUTSIDE_WORKING_AREA),
    (4, ErrorCodes.WEAK_GPS_SIGNAL),
    (8, ErrorCodes.LOW_BATTERY),
    (12, ErrorCodes.DIFFICULT_FINDING_HOME),
]


class DemoMower(Mower):
    def __init__(
        self,
        address: str = DEMO_ADDRESS,
        speed: float = 10.0,
        origin: tuple[float, float] = (52.52, 13.40),
        channel_id: int = 1197489078,
        battery: float = 100.0,
        seed: int | None = None,
    ):
        if speed <= 0:
            raise ValueError("speed must be > 0")
        super().__init__(channel_id, address)
        self.speed = speed
        self.origin = origin
        self._rng = random.Random(seed)
        self._connected = False
        self._last = time.monotonic()

        self._battery = float(battery)
        self._phase = "docked"            # docked | out | mow | home
        self._paused = False
        self._mode = ModeOfOperation.AUTO
        self._override: dict | None = None  # {action, start (epoch), duration}
        self._cutting_height = 4

        self._s = 0.0                     # distance along the mowing path
        self._pos = DOCK_M
        self._travel_from = DOCK_M
        self._travel_to = DOCK_M
        self._travel_total = 1.0
        self._travel_done = 0.0

        self._tasks = [dict(t) for t in _DEFAULT_TASKS]
        self._pending_tasks: list[dict] | None = None
        self._clock_offset = 0

        # Lifetime counters in seconds, plausible for a mower a couple of seasons old.
        self._stats = {
            "running": 1_480_000.0,
            "cutting": 1_230_000.0,
            "charging": 690_000.0,
            "searching": 210_000.0,
            "collisions": 2_400.0,
            "cycles": 180.0,
            "blade": 306_000.0,
        }
        now = time.time()
        self._messages = [
            {"time": self._local_unix(now - d * 86400), "code": int(c), "severity": 1}
            for d, c in _DEFAULT_MESSAGES
        ]

    # ─── Connection ─────────────────────────────────────────────────────────

    async def connect(self, device=None) -> ResponseResult:
        self._connected = True
        return ResponseResult.OK

    async def disconnect(self):
        self._connected = False

    def is_connected(self) -> bool:
        return self._connected

    # ─── Simulation ─────────────────────────────────────────────────────────

    @property
    def docked(self) -> bool:
        return self._phase == "docked"

    def advance(self) -> None:
        """Bring the simulation up to the present."""
        now_m = time.monotonic()
        real_dt = min(now_m - self._last, _MAX_CATCHUP_S)
        self._last = now_m
        t0 = time.time() - real_dt
        elapsed = 0.0
        while elapsed < real_dt - 1e-9:
            step = min(_STEP_S, real_dt - elapsed)
            elapsed += step
            self._step(step, t0 + elapsed)

    def _step(self, dt_real: float, t: float) -> None:
        dt_sim = dt_real * self.speed
        ov = self._override
        if ov and t >= ov["start"] + ov["duration"]:
            self._override = None
        wants = self._wants_to_mow(t)

        if self._phase == "docked":
            if self._battery < 100.0:
                self._battery += CHARGE_PCT_PER_H * dt_sim / 3600
                if self._battery >= 99.5:
                    self._battery = 100.0
                self._stats["charging"] += dt_sim
            if wants and not self._paused and self._battery >= RESUME_BATTERY_PCT:
                self._begin_travel("out", self._path_point(self._s))
            return
        if self._paused:
            return

        if self._phase == "mow":
            self._battery -= DISCHARGE_PCT_PER_H * dt_sim / 3600
            self._stats["running"] += dt_sim
            self._stats["cutting"] += dt_sim
            self._stats["blade"] += dt_sim
            if self._rng.random() < dt_sim / _COLLISION_EVERY_S:
                self._stats["collisions"] += 1
            self._s += GROUND_SPEED_MS * dt_real
            self._pos = self._path_point(self._s)
            if not wants or self._battery <= LOW_BATTERY_PCT:
                self._begin_travel("home", DOCK_M)
            return

        # Driving between the station and the lawn
        self._battery -= SEARCH_DISCHARGE_PCT_PER_H * dt_sim / 3600
        self._stats["running"] += dt_sim
        self._stats["searching"] += dt_sim
        arrived = self._advance_travel(dt_real)
        if self._phase == "out":
            if not wants:
                self._begin_travel("home", DOCK_M)
            elif arrived:
                self._phase = "mow"
        elif arrived:
            self._phase = "docked"
            self._stats["cycles"] += 1

    def _begin_travel(self, phase: str, target: tuple[float, float]) -> None:
        self._phase = phase
        self._travel_from = self._pos
        self._travel_to = target
        dist = math.dist(self._pos, target)
        self._travel_total = max(dist / GROUND_SPEED_MS, 1.0)
        self._travel_done = 0.0

    def _advance_travel(self, dt_real: float) -> bool:
        self._travel_done += dt_real
        f = min(1.0, self._travel_done / self._travel_total)
        (x0, y0), (x1, y1) = self._travel_from, self._travel_to
        self._pos = (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)
        return f >= 1.0

    @staticmethod
    def _path_point(s: float) -> tuple[float, float]:
        """Position along a back-and-forth lane pattern covering the lawn."""
        lanes = int(LAWN_HEIGHT_M // LANE_SPACING_M)
        lane, d = divmod(s % (lanes * LAWN_WIDTH_M), LAWN_WIDTH_M)
        lane = int(lane)
        x = d if lane % 2 == 0 else LAWN_WIDTH_M - d
        return (x, lane * LANE_SPACING_M)

    # ─── Scheduling ─────────────────────────────────────────────────────────

    def _wants_to_mow(self, t: float) -> bool:
        if self._mode not in (ModeOfOperation.AUTO, ModeOfOperation.DEMO):
            return False
        ov = self._override
        if ov and t < ov["start"] + ov["duration"]:
            return ov["action"] == OverrideAction.FORCEDMOW
        return self._in_window(t)

    def _in_window(self, t: float) -> bool:
        local = dt.datetime.fromtimestamp(t)
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        for task in self._tasks:
            for back in (0, 1):  # a window may run past midnight
                if not task["days"][(local.weekday() - back) % 7]:
                    continue
                start = midnight - dt.timedelta(days=back, seconds=-task["start"])
                if start <= local < start + dt.timedelta(seconds=task["duration"]):
                    return True
        return False

    def _next_task_start(self, after: float) -> dt.datetime | None:
        local = dt.datetime.fromtimestamp(after)
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        best = None
        for ahead in range(8):
            for task in self._tasks:
                if not task["days"][(midnight.weekday() + ahead) % 7]:
                    continue
                start = midnight + dt.timedelta(days=ahead, seconds=task["start"])
                if start > local and (best is None or start < best):
                    best = start
        return best

    def _status(self, t: float) -> tuple[MowerState, MowerActivity, int]:
        """Return (state, activity, restriction reason)."""
        if self._phase == "docked":
            activity = (
                MowerActivity.CHARGING if self._battery < 100.0 else MowerActivity.PARKED
            )
        else:
            activity = {
                "out": MowerActivity.GOING_OUT,
                "mow": MowerActivity.MOWING,
                "home": MowerActivity.GOING_HOME,
            }[self._phase]
        if self._paused:
            if self._phase != "docked":
                activity = MowerActivity.STOPPED_IN_GARDEN
            return MowerState.PAUSED, activity, 0
        if self._phase != "docked" or self._wants_to_mow(t):
            return MowerState.IN_OPERATION, activity, 0
        ov = self._override
        parked_by_user = self._mode == ModeOfOperation.HOME or (
            ov is not None and ov["action"] == OverrideAction.FORCEDPARK
        )
        return MowerState.RESTRICTED, activity, 2 if parked_by_user else 1

    # ─── GPS ────────────────────────────────────────────────────────────────

    def gps_fix(self) -> dict:
        """Current position as a GNSS tracker mounted on the mower would report it."""
        x = self._pos[0] + self._rng.gauss(0, 0.03)
        y = self._pos[1] + self._rng.gauss(0, 0.03)
        lat0, lon0 = self.origin
        return {
            "lat": lat0 + y / _M_PER_DEG_LAT,
            "lon": lon0 + x / (_M_PER_DEG_LAT * math.cos(math.radians(lat0))),
            "accuracy_m": 0.05,
        }

    # ─── Protocol ───────────────────────────────────────────────────────────

    @staticmethod
    def _local_unix(t: float | None = None) -> int:
        """Protocol time: seconds since 1970 in local wall-clock time."""
        local = dt.datetime.fromtimestamp(t if t is not None else time.time())
        return int(calendar.timegm(local.timetuple()))

    async def command(self, command_name: str, **kwargs):
        self.advance()
        t = time.time()
        st = self._stats

        match command_name:
            case "GetBatteryLevel":
                return int(round(self._battery))
            case "IsCharging":
                return self._phase == "docked" and self._battery < 100.0
            case "GetRemainingChargingTime":
                if self._phase != "docked" or self._battery >= 100.0:
                    return 0
                hours = (100.0 - self._battery) / CHARGE_PCT_PER_H / self.speed
                return int(hours * 3600)
            case "GetState":
                return int(self._status(t)[0])
            case "GetActivity":
                return int(self._status(t)[1])
            case "GetRestrictionReason":
                return self._status(t)[2]
            case "GetError":
                return 0
            case "GetMode":
                return int(self._mode)
            case "SetMode":
                self._mode = ModeOfOperation(kwargs["mode"])
            case "StartTrigger":
                self._paused = False
            case "Pause":
                self._paused = True
            case "SetOverrideMow":
                self._set_override(OverrideAction.FORCEDMOW, t, kwargs["duration"])
            case "SetOverridePark":
                self._set_override(OverrideAction.FORCEDPARK, t, kwargs["duration"])
            case "SetOverrideParkUntilNextStart":
                nxt = self._next_task_start(t)
                until = nxt.timestamp() - t if nxt else _FAR_FUTURE_S
                self._set_override(OverrideAction.FORCEDPARK, t, until)
            case "ClearOverride":
                self._override = None
            case "GetOverride":
                ov = self._override
                if ov is None or t >= ov["start"] + ov["duration"]:
                    return {"action": 0, "startTime": 0, "duration": 0}
                return {
                    "action": int(ov["action"]),
                    "startTime": self._local_unix(ov["start"]),
                    "duration": int(ov["duration"]),
                }
            case "GetNextStartTime":
                if self._in_window(t):
                    return 0
                nxt = self._next_task_start(t)
                return self._local_unix(nxt.timestamp()) if nxt else 0

            case "GetTime":
                return self._local_unix(t) + self._clock_offset
            case "SetTime":
                self._clock_offset = kwargs["time"] - self._local_unix(t)
            case "GetNumberOfTasks":
                return len(self._tasks)
            case "GetTask":
                i = kwargs["taskId"]
                if not 0 <= i < len(self._tasks):
                    return None
                task = self._tasks[i]
                days = ("Monday", "Tuesday", "Wednesday", "Thursday",
                        "Friday", "Saturday", "Sunday")
                return {
                    "start": task["start"],
                    "duration": task["duration"],
                    **{f"useOn{d}": bool(task["days"][n]) for n, d in enumerate(days)},
                }
            case "StartTaskTransaction":
                self._pending_tasks = []
            case "DeleteAllTask":
                if self._pending_tasks is not None:
                    self._pending_tasks = []
                else:
                    self._tasks = []
            case "AddTask":
                days = ("Monday", "Tuesday", "Wednesday", "Thursday",
                        "Friday", "Saturday", "Sunday")
                task = {
                    "start": kwargs["start"],
                    "duration": kwargs["duration"],
                    "days": [int(bool(kwargs[f"useOn{d}"])) for d in days],
                }
                (self._pending_tasks if self._pending_tasks is not None
                 else self._tasks).append(task)
            case "CommitTaskTransaction":
                if self._pending_tasks is not None:
                    self._tasks, self._pending_tasks = self._pending_tasks, None

            case "GetUserMowerNameAsAsciiString":
                return "Demo Mower"
            case "GetSerialNumber":
                return 424242424
            case "GetModel":
                return {"deviceType": 8, "deviceVariant": 0}  # Automower 450X
            case "GetCuttingHeight":
                return self._cutting_height
            case "SetCuttingHeight":
                self._cutting_height = max(1, min(9, int(kwargs["height"])))
            case "GetAllStatistics":
                return {
                    "totalRunningTime": int(st["running"]),
                    "totalCuttingTime": int(st["cutting"]),
                    "totalChargingTime": int(st["charging"]),
                    "totalSearchingTime": int(st["searching"]),
                    "numberOfCollisions": int(st["collisions"]),
                    "numberOfChargingCycles": int(st["cycles"]),
                    "cuttingBladeUsageTime": int(st["blade"]),
                }
            case "GetTotalRunningTime":
                return int(st["running"])
            case "GetTotalCuttingTime":
                return int(st["cutting"])
            case "GetTotalChargingTime":
                return int(st["charging"])
            case "GetTotalSearchingTime":
                return int(st["searching"])
            case "GetNumberOfCollisions":
                return int(st["collisions"])
            case "GetNumberOfChargingCycles":
                return int(st["cycles"])
            case "ResetCuttingBladeUsageTime":
                st["blade"] = 0.0
            case "GetNumberOfMessages":
                return len(self._messages)
            case "GetMessage":
                i = kwargs["messageId"]
                return self._messages[i] if 0 <= i < len(self._messages) else None

            case "KeepAlive" | "EnterOperatorPin":
                pass
            case "IsOperatorLoggedIn":
                return True
            case "GetStartupSequenceRequired":
                return False
            case _:
                logger.warning("Demo mower: unsupported command %s", command_name)
        return None

    def _set_override(self, action: OverrideAction, start: float, duration: float) -> None:
        self._override = {"action": action, "start": start, "duration": duration}
