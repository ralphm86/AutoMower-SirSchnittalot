'use strict';
/* Concept only: every value below is illustrative. A real GUI renders server state. */

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ic = n => `<i class="bi bi-${n}" aria-hidden="true"></i>`;
const t2m = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const m2t = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dur = m => {
  if (m == null) return '—';
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h ? (r ? `${h} h ${r} m` : `${h} h`) : `${r} m`;
};
const ACTIONS = {};
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- shared vocabulary (see BACKEND_CONTRACTS.md) ----------
const ACTIVITY = {
  parked:    { title: 'Parked at home',           icon: 'house-check',      tone: '' },
  mowing:    { title: 'Mowing',                   icon: 'play-circle',      tone: '' },
  charging:  { title: 'Charging between sessions', icon: 'battery-charging', tone: '' },
  paused:    { title: 'Paused in the garden',     icon: 'pause-circle',     tone: 'warn' },
  returning: { title: 'Returning home',           icon: 'house-down',       tone: 'info' },
  error:     { title: 'Needs attention',          icon: 'exclamation-octagon', tone: 'bad' },
};
// Planner decision codes -> user labels (planner.plan_schedule status codes plus planned additions)
const CODES = {
  session:   { tag: 'Planned',        cls: '',     icon: 'check2' },
  done:      { tag: 'Completed',      cls: 'gray', icon: 'check2-circle' },
  cold:      { tag: 'Too cold',       cls: 'blue', icon: 'thermometer-low' },
  rain:      { tag: 'Rain',           cls: 'blue', icon: 'cloud-rain' },
  interval:  { tag: 'Rest day',       cls: 'gray', icon: 'calendar-x' },
  growth:    { tag: 'Lawn recovery',  cls: 'gray', icon: 'flower1' },
  no_window: { tag: 'No window',      cls: 'amber', icon: 'clock-history' },
  firmware:  { tag: 'Firmware start', cls: 'gray', icon: 'clock' },
  none:      { tag: 'No start',       cls: 'gray', icon: 'dash-circle' },
};

// ---------- sample data (consistent: Berlin, Mon 16 - Sun 22 Nov 2026) ----------
const WEEK = [['Mon', 16, 'Monday'], ['Tue', 17, 'Tuesday'], ['Wed', 18, 'Wednesday'], ['Thu', 19, 'Thursday'], ['Fri', 20, 'Friday'], ['Sat', 21, 'Saturday'], ['Sun', 22, 'Sunday']];
const FC = [
  { hi: 8, lo: 5, icon: 'cloud-sun', txt: 'Partly cloudy', rain: 0, wind: 3.6 },
  { hi: 4, lo: 2, icon: 'cloud-drizzle', txt: 'Drizzle', rain: 0.3, wind: 5.1 },
  { hi: 9, lo: 6, icon: 'cloud-sun', txt: 'Partly cloudy', rain: 0, wind: 2.8 },
  { hi: 8, lo: 5, icon: 'cloud', txt: 'Cloudy', rain: 0, wind: 3.2 },
  { hi: 10, lo: 6, icon: 'sun', txt: 'Sunny', rain: 0, wind: 2.2 },
  { hi: 8, lo: 4, icon: 'cloud-sun', txt: 'Partly cloudy', rain: 0, wind: 4.0 },
  { hi: 7, lo: 3, icon: 'cloud', txt: 'Cloudy', rain: 0, wind: 4.4 },
];
const FC_ZERO = [FC[0], { ...FC[1] }, { hi: 3, lo: 1, icon: 'cloud-snow', txt: 'Sleet', rain: 0.2, wind: 4.8 }, { hi: 6, lo: 4, icon: 'cloud-rain', txt: 'Rain', rain: 1.8, wind: 6.1 }, { hi: 4, lo: 1, icon: 'cloud', txt: 'Cloudy', rain: 0, wind: 3.0 }, { hi: 5, lo: 2, icon: 'cloud', txt: 'Cloudy', rain: 0, wind: 3.4 }, { hi: 5, lo: 2, icon: 'cloud', txt: 'Cloudy', rain: 0, wind: 3.9 }];
const mk = (code, reason, slot) => ({ code, reason, slot: slot || null });
const slot = (s, e, mow, chg) => ({ s, e, mow, chg });
const DONE = mk('done', 'Session finished 13:25 · 1 h 30 m mowed.');
const DAYS = {
  fixed: [
    DONE,
    mk('interval', 'Mowed Monday; your mowing interval is 2 days.'),
    mk('session', 'Interval reached. Dry, 9 °C. Start 10:00, after dew has cleared.', slot('10:00', '12:15', 90, 45)),
    mk('interval', 'Mowed Wednesday; mowing interval is 2 days.'),
    mk('session', 'Interval reached. Dry, 10 °C, suitable daylight window.', slot('10:00', '12:15', 90, 45)),
    mk('interval', 'Mowed Friday; mowing interval is 2 days.'),
    mk('no_window', 'Interval reached, but Sunday is not in your mowing windows.'),
  ],
  adaptive: [
    DONE,
    mk('cold', 'A session is due (2.4 h owed) but 3.6–4.1 °C is below your 5 °C minimum.'),
    mk('session', '3.1 h owed (threshold 2.3 h). Dry, 9 °C. Start 10:00, after dew has cleared.', slot('10:00', '13:15', 120, 75)),
    mk('growth', '1.8 h owed is below the 2.3 h session threshold.'),
    mk('session', '2.5 h owed (threshold 2.3 h). Dry, 10 °C, suitable daylight window.', slot('10:00', '13:15', 120, 75)),
    mk('growth', '1.2 h owed is below the 2.3 h session threshold.'),
    mk('no_window', 'Sunday is not in your mowing windows (1.9 h owed).'),
  ],
  zero: [
    DONE,
    mk('cold', '3.6–4.1 °C during your window; minimum is 5 °C.'),
    mk('cold', '1–3 °C during your window; minimum is 5 °C.'),
    mk('rain', 'Rain 1.8 mm/h exceeds your 0.5 mm/h limit.'),
    mk('cold', '1–4 °C during your window; minimum is 5 °C.'),
    mk('cold', '2–5 °C; below the 5 °C minimum for most of the window.'),
    mk('no_window', 'Sunday is not in your mowing windows.'),
  ],
  classic: [
    mk('done', 'Firmware start 10:50 ran · 1 h 30 m mowed.'),
    mk('firmware', 'Firmware calendar starts 10:00. Weather is not checked in Classic mode.', slot('10:00', '13:00', null, null)),
    mk('firmware', 'Firmware calendar starts 10:00.', slot('10:00', '13:00', null, null)),
    mk('firmware', 'Firmware calendar starts 10:00.', slot('10:00', '13:00', null, null)),
    mk('firmware', 'Firmware calendar starts 10:00.', slot('10:00', '13:00', null, null)),
    mk('firmware', 'Firmware calendar starts 09:00.', slot('09:00', '11:00', null, null)),
    mk('none', 'No start in the firmware calendar.'),
  ],
};
const SAVED_CALENDAR = [
  { id: 1, start: '10:00', hours: 3, days: [1, 1, 1, 1, 1, 0, 0] },
  { id: 2, start: '09:00', hours: 2, days: [0, 0, 0, 0, 0, 1, 0] },
  { id: 3, start: '17:30', hours: 1, days: [0, 0, 0, 1, 0, 0, 0] },
];
const SEG_RATE = { mow: -0.4, search: -0.3, charge: 0.55 };
const SESSIONS = [
  { id: 's1', date: 'Mon 16 Nov', start: '10:50', kind: 'complete', end_reason: 'Target of 1 h 30 m mowing reached; returned to the station.', seg: [['mow', 45], ['charge', 55], ['mow', 45], ['search', 10]], gps: 84 },
  { id: 's2', date: 'Sat 14 Nov', start: '09:30', kind: 'complete', end_reason: 'Planned end reached; returned to the station.', seg: [['mow', 55], ['charge', 50], ['mow', 50], ['search', 5]], gps: 91 },
  { id: 's3', date: 'Thu 12 Nov', start: '10:05', kind: 'interrupted', end_reason: 'Weather watchdog parked the mower: rain 2.4 mm/h exceeded 0.5 mm/h.', seg: [['mow', 62], ['search', 13]], gps: 47 },
  { id: 's4', date: 'Sun 8 Nov', start: '10:30', kind: 'incomplete', end_reason: 'Connection lost at 11:30. The end time and reason were not observed.', seg: [['mow', 55], ['search', 5]], gps: null },
  { id: 's5', date: 'Tue 3 Nov', start: '—', kind: 'imported', end_reason: 'Imported from the legacy history file: only the mowing total was recorded.', seg: null, mowOnly: 120, gps: null },
];
const MESSAGES = [
  { when: 'Fri 13 Nov 15:02', name: 'Trapped', sev: 'Error', resolved: 'Cleared 15:20' },
  { when: 'Mon 2 Nov 09:14', name: 'Wheel motor overloaded, right', sev: 'Warning', resolved: 'Cleared 09:31' },
];
const LOG0 = [
  { when: 'Mon 14:05', src: 'Planner', icon: 'arrow-repeat', text: 'Plan recalculated: 2 sessions in the next 7 days' },
  { when: 'Mon 13:25', src: 'Mower', icon: 'check-circle', text: 'Session complete: 1 h 30 m mowed, returned to the station' },
  { when: 'Mon 10:50', src: 'Command', icon: 'terminal', text: 'Planner started a session (direct override)' },
  { when: 'Mon 08:05', src: 'Planner', icon: 'arrow-repeat', text: 'Weekly plan updated' },
  { when: 'Sun 15 Nov 18:20', src: 'Connection', icon: 'bluetooth', text: 'Reconnected after 4 min' },
];

// ---------- state ----------
const BASE = {
  conn: 'connected', fresh: 'live', lastSeen: null, firstRun: false,
  mode: 'smart', adaptive: false, cal: 'user', calSaved: true,
  today: 0, now: '14:05', activity: 'parked', battery: 100,
  session: null, plannerPaused: null, hold: null, error: null,
  weather: 'ok', plan: 'ok', winter: false, winterSince: null, advice: null,
  samples: 1482, bladeHours: 63,
  cmd: null, log: null, calDraft: null,
  nextCmd: 'ok', nextRecalc: 'ok', switchFail: 'none', nextConnect: 'ok',
  adviceLater: false, snow: true,
};
const PRESETS = [
  ['idle', 'Idle at home (Smart)', {}],
  ['mow-planned', 'Mowing: planned session', { today: 2, now: '10:40', activity: 'mowing', battery: 78, session: { kind: 'planned', start: '10:00', mow: 40, chg: 0 } }],
  ['charging', 'Charging mid-session', { today: 2, now: '11:25', activity: 'charging', battery: 31, session: { kind: 'planned', start: '10:00', mow: 45, chg: 20 } }],
  ['manual', 'Mowing: manual session', { activity: 'mowing', battery: 96, session: { kind: 'manual', start: '14:05', end: '15:05', mow: 0, chg: 0 } }],
  ['paused', 'Paused in the garden', { today: 2, now: '10:52', activity: 'paused', battery: 64, plannerPaused: { kind: 'pause' }, session: { kind: 'planned', start: '10:00', mow: 52, chg: 0 } }],
  ['returning', 'Returning home (until resumed)', { today: 2, now: '10:52', activity: 'returning', battery: 58, plannerPaused: { kind: 'park' }, session: { kind: 'planned', start: '10:00', mow: 52, chg: 0 } }],
  ['parked-user', 'Parked by you (until resumed)', { plannerPaused: { kind: 'park' } }],
  ['hold-weather', 'Weather hold (watchdog)', { today: 2, now: '10:52', activity: 'parked', battery: 72, hold: { kind: 'weather', at: '10:52', why: 'thunderstorm warning; rain 2.4 mm/h exceeds your 0.5 mm/h limit' }, session: { kind: 'planned', start: '10:00', mow: 52, chg: 0, interrupted: true } }],
  ['hold-drying', 'Drying delay (watchdog)', { today: 2, now: '11:40', activity: 'parked', battery: 80, hold: { kind: 'drying', at: '10:52', clear: '11:20', resume: '12:20' }, session: { kind: 'planned', start: '10:00', mow: 52, chg: 0, interrupted: true } }],
  ['error', 'Active mower error', { today: 2, now: '10:58', activity: 'error', battery: 66, error: { name: 'Trapped', since: '10:52' }, session: { kind: 'planned', start: '10:00', mow: 52, chg: 0, interrupted: true } }],
  ['lost', 'Connection lost (stale data)', { conn: 'disconnected', fresh: 'stale', lastSeen: '13:25' }],
  ['reconnecting', 'Reconnecting', { conn: 'reconnecting', fresh: 'stale', lastSeen: '13:25' }],
  ['first', 'First visit (no mower set up)', { conn: 'disconnected', firstRun: true, fresh: 'stale', battery: null, plan: 'invalid' }],
  ['zero', 'Plan with zero sessions', { plan: 'zero' }],
  ['failed', 'Recalculation failed', { plan: 'failed' }],
  ['invalid', 'Invalid planner setup', { plan: 'invalid' }],
  ['weather-off', 'Weather data unavailable', { weather: 'unavailable' }],
  ['classic', 'Classic mode idle', { mode: 'classic' }],
  ['classic-mow', 'Classic mode mowing (firmware)', { mode: 'classic', today: 2, now: '10:40', activity: 'mowing', battery: 78, session: { kind: 'firmware', start: '10:00', mow: 40, chg: 0 } }],
  ['classic-weather', 'Classic: weather hold (watchdog)', { mode: 'classic', today: 2, now: '10:52', activity: 'parked', battery: 72, hold: { kind: 'weather', at: '10:52', why: 'thunderstorm warning; rain 2.4 mm/h exceeds your 0.5 mm/h limit' } }],
  ['classic-drying', 'Classic: drying delay (watchdog)', { mode: 'classic', today: 2, now: '11:40', activity: 'parked', battery: 80, hold: { kind: 'drying', at: '10:52', clear: '11:20', resume: '12:20' } }],
  ['placeholder', 'Classic: calendar not restored', { mode: 'classic', cal: 'placeholder' }],
  ['winter', 'Winter mode active', { winter: true, winterSince: '1 Nov 2026', conn: 'disconnected', fresh: 'stale', lastSeen: '31 Oct', plan: 'invalid' }],
  ['advice-enter', 'Winter advice: enter', { advice: 'enter' }],
  ['advice-end', 'Winter advice: end', { winter: true, winterSince: '1 Nov 2026', conn: 'disconnected', fresh: 'stale', lastSeen: '31 Oct', plan: 'invalid', advice: 'end' }],
];
let S;
let cfgSaved, CFG, LOC, CONNUI;
function freshConfig() {
  cfgSaved = {
    windows: [0, 1, 2, 3, 4, 5].map(day => ({ day, s: '09:00', e: '16:00' })),
    target: 1.5, interval: 2, minDur: 60, maxDur: 360,
    sessionHours: 3, peakInterval: 2, soil: 40,
    minTemp: 5, maxRain: 0.5, maxWind: 8, rainDelay: 2,
    daylight: true, dew: true, dewAuto: true, dewHours: 2, heat: false, heatTemp: 28, heatInterval: 2,
    wdOn: true, wdEvery: 10, wdDry: 60,
    replanEvery: 6, replanAt: '05:00',
  };
  CFG = JSON.parse(JSON.stringify(cfgSaved));
  LOC = { name: 'Berlin, Germany', lat: 52.52, lon: 13.405, tz: 'Europe/Berlin (CET, UTC+1)', draft: { city: '', lat: '', lon: '' }, msg: null };
  CONNUI = { scan: 'idle', timeout: 10, found: [], sel: '', addr: '', channel: 1, pin: '', msg: null };
}
function applyPreset(id) {
  const p = PRESETS.find(x => x[0] === id) || PRESETS[0];
  const keep = { adaptive: S ? S.adaptive : false, nextCmd: S ? S.nextCmd : 'ok', nextRecalc: S ? S.nextRecalc : 'ok', switchFail: S ? S.switchFail : 'none', nextConnect: S ? S.nextConnect : 'ok', snow: S ? S.snow : true };
  S = Object.assign(JSON.parse(JSON.stringify(BASE)), keep, JSON.parse(JSON.stringify(p[2])));
  S.preset = id;
  S.log = JSON.parse(JSON.stringify(LOG0));
  if (S.mode === 'classic' && S.cal === 'user') { /* calendar already the user's */ }
  if (S.firstRun) S.log = [];
  if (S.winter) { S.log = [{ when: '1 Nov 09:00', src: 'Planner', icon: 'snow', text: 'Winter mode started: planning, watchdog and auto-reconnect paused' }]; }
  if (!cfgSaved) freshConfig();
  cfgSaved.adaptive = S.adaptive; CFG.adaptive = S.adaptive;
  const noLoc = id === 'invalid' || id === 'first';
  if (noLoc) Object.assign(LOC, { name: '', lat: null, lon: null, tz: '' });
  else if (LOC.lat == null) Object.assign(LOC, { name: 'Berlin, Germany', lat: 52.52, lon: 13.405, tz: 'Europe/Berlin (CET, UTC+1)' });
}

// ---------- derived ----------
function planDays() {
  let key = S.mode === 'classic' ? 'classic' : S.plan === 'zero' ? 'zero' : S.adaptive ? 'adaptive' : 'fixed';
  const fc = key === 'zero' ? FC_ZERO : FC;
  return DAYS[key].map((d, i) => ({ ...d, i, w: WEEK[i], f: fc[i] }));
}
const dayName = i => `${WEEK[i][2]}, ${WEEK[i][1]} November`;
const live = () => S.session && ['mowing', 'charging'].includes(S.activity);
function sessInfo() {
  const x = S.session; if (!x) return null;
  const d = planDays()[S.today];
  const end = x.kind === 'planned' && d.slot ? d.slot.e : (x.kind === 'firmware' && d.slot ? d.slot.e : x.end);
  const nowM = t2m(S.now), endM = t2m(end);
  return { ...x, end, remain: Math.max(0, endM - nowM), elapsed: x.mow + x.chg };
}
function upcoming() {
  return planDays().filter(d => d.slot && (d.i > S.today || (d.i === S.today && !S.session && !d.done && t2m(d.slot.s) > t2m(S.now))));
}
const planStale = () => S.plan === 'failed' || S.weather === 'unavailable';
const dirty = () => JSON.stringify(CFG) !== JSON.stringify(cfgSaved);
const canCmd = () => S.conn === 'connected' && !S.winter;
const pending = () => S.cmd && ['sending', 'accepted'].includes(S.cmd.stage);
function lastNext() {
  const u = upcoming()[0];
  if (S.mode === 'classic') return u ? { title: `${dayName(u.i)}, ${u.slot.s}`, sub: `${dur(t2m(u.slot.e) - t2m(u.slot.s))} per firmware calendar · weather is not checked before the start` } : { title: 'No start this week', sub: 'The firmware calendar has no further starts.' };
  return u ? { title: `${u.w[2]}, ${u.slot.s}`, sub: `${dur(u.slot.mow)} mowing · until about ${u.slot.e} including charging` } : null;
}
function nextAvail() {
  const c = canCmd(), p = pending(), smart = S.mode === 'smart';
  const base = c && !p ? { ok: true } : { ok: false, why: !canCmd() ? (S.winter ? 'Winter mode is active' : 'Not connected') : 'Another command is in progress' };
  const mowing = ['mowing', 'charging'].includes(S.activity);
  const r = (ok, why) => (base.ok ? (ok ? { ok: true } : { ok: false, why }) : base);
  return {
    mow: r(!mowing, 'The mower is already mowing'),
    pause: r(['mowing', 'charging', 'returning'].includes(S.activity), 'The mower is not mowing'),
    park: r(!(S.activity === 'parked' && S.plannerPaused && S.plannerPaused.kind === 'park' && smart), 'Already parked until resumed'),
    parkfor: r(true),
    skip: r(smart ? !!(S.session && ['mowing', 'charging', 'paused'].includes(S.activity)) : mowing, smart ? 'No active session to skip' : 'The mower is not mowing'),
    resume: r(!!(S.plannerPaused || S.activity === 'paused' || S.hold), 'Nothing to resume'),
  };
}
function statusModel() {
  const smart = S.mode === 'smart';
  const nx = lastNext();
  const side = { eyebrow: '', title: '', sub: '', tag: '' };
  let m = { tone: '', icon: 'house-check', title: '', reason: '', actions: '', side };
  if (S.winter) {
    return { tone: 'info', icon: 'snow', title: 'Winter mode', reason: 'Planning, the weather watchdog and auto-reconnect are paused. The mower\'s own schedule is unchanged; the mower itself was not stopped or stored by this app.',
      actions: `<button class="button primary" data-act="winter-leave">${ic('sun')}Leave winter mode</button><a class="button" href="#settings">${ic('gear')}Season settings</a>`,
      side: { eyebrow: 'Since', title: S.winterSince, sub: 'Season ends about 15 Mar 2027 (your dates in Settings). Last known mower values are from ' + S.lastSeen + '.', tag: `${ic('snow')}Planner paused` } };
  }
  if (S.firstRun) return { tone: 'off', icon: 'bluetooth', title: 'No mower connected yet', reason: 'Connect your Automower over Bluetooth to see its status and plan mowing.', actions: `<a class="button primary" href="#settings">${ic('bluetooth')}Set up connection</a>`, side: { eyebrow: 'What you need', title: 'Mower in range', sub: 'Keep the mower awake and within a few metres. The PIN is optional and never shown again after sending.', tag: '' } };
  if (S.conn !== 'connected') {
    const rec = S.conn === 'reconnecting';
    return { tone: rec ? 'warn' : 'bad', icon: rec ? 'arrow-repeat' : 'bluetooth', title: rec ? 'Reconnecting…' : 'Connection lost',
      reason: `Live data is unavailable. Showing last known values from ${S.lastSeen}: ${ACTIVITY[S.activity].title.toLowerCase()}, battery ${S.battery}%.`,
      actions: `<button class="button primary" data-act="reconnect" ${rec ? 'disabled' : ''}>${ic('arrow-repeat')}Reconnect now</button><a class="button" href="#settings">${ic('gear')}Connection settings</a>`,
      side: { eyebrow: 'Next planned session', title: nx ? nx.title : 'None', sub: (nx ? nx.sub + '. ' : '') + 'The plan is kept, but sessions are not started while the mower is unreachable.', tag: `${ic('clock-history')}Last known` } };
  }
  const a = ACTIVITY[S.activity];
  m.tone = a.tone; m.icon = a.icon; m.title = a.title;
  const sIn = sessInfo();
  const smartTag = smart ? `${ic('stars')}Smart mode · planner in control` : `${ic('calendar-week')}Classic mode · firmware calendar`;
  const idleNext = () => {
    if (!smart) return { eyebrow: 'Next firmware start', title: nx ? nx.title : 'None', sub: nx ? nx.sub : '', tag: smartTag };
    if (S.plannerPaused) return { eyebrow: 'Planned sessions', title: 'Paused by you', sub: S.plannerPaused.kind === 'pause' ? 'The planner skips sessions until you press Resume.' : (S.plannerPaused.until ? `The planner skips sessions until ${S.plannerPaused.until}.` : 'The planner skips sessions until you press Resume.'), tag: smartTag };
    if (S.plan === 'invalid') return { eyebrow: 'Next planned session', title: 'No plan yet', sub: 'Planning needs a location and at least one mowing window.', tag: smartTag };
    if (S.plan === 'zero') return { eyebrow: 'Next planned session', title: 'None this week', sub: 'Calculated 14:05: too cold Tue, Wed, Fri and Sat, rain Thu, no mowing window Sun.', tag: `${ic('info-circle')}Plan calculated: no sessions` };
    if (S.plan === 'failed') return { eyebrow: 'Next planned session', title: nx ? nx.title : 'None', sub: 'This plan is from 08:05. Recalculation at 14:05 failed, so it may be outdated.', tag: `${ic('exclamation-triangle')}Possibly outdated` };
    return { eyebrow: 'Next planned session', title: nx ? nx.title : 'None', sub: nx ? nx.sub : 'No session is planned in the next 7 days.', tag: smartTag };
  };
  if (S.activity === 'mowing' || S.activity === 'charging') {
    const manual = sIn.kind === 'manual', fw = sIn.kind === 'firmware';
    m.reason = S.activity === 'charging' ? `Charging at the station; mowing continues automatically. ${manual ? 'Manual session' : fw ? 'Firmware session' : 'Planned session'} until ${sIn.end}.` : (manual ? `Manual session. ${smart ? 'The planner resumes after it ends.' : 'The mower returns when the override ends.'}` : fw ? 'Started by the mower\'s own calendar.' : 'Planned session; weather checks passed at start.');
    m.actions = `<button class="button" data-act="cmd-pause">${ic('pause-fill')}Pause</button><a class="button" href="#control">${ic('sliders2')}All controls</a>`;
    m.side = { eyebrow: 'Current session', title: `Until ${sIn.end}`, sub: `${dur(sIn.remain)} remaining${S.activity === 'charging' ? ' · charging first' : ''}. Mowing so far ${dur(sIn.mow)}; elapsed including charging ${dur(sIn.elapsed)}.`, tag: manual ? `${ic('hand-index')}Manual session` : smartTag };
  } else if (S.activity === 'paused') {
    m.reason = smart ? 'Stopped where it is. The planner is paused too: no session starts until you resume.' : 'Stopped where it is. Press Resume to continue.';
    m.actions = `<button class="button primary" data-act="cmd-resume">${ic('play')}Resume</button><button class="button" data-act="cmd-park">${ic('house-down')}Park home</button>`;
    m.side = idleNext(); m.side.eyebrow = smart ? 'Planner' : 'Next firmware start';
  } else if (S.activity === 'returning') {
    m.reason = smart ? 'Heading to the station. The planner stays paused until you resume.' : 'Heading to the station in HOME mode until you resume.';
    m.actions = `<button class="button primary" data-act="cmd-resume">${ic('play')}Resume</button>`;
    m.side = idleNext();
  } else if (S.activity === 'error') {
    m.reason = `${S.error.name} since ${S.error.since}. The mower has stopped. Free it, then confirm on the mower.`;
    m.actions = `<a class="button primary" href="#activity/messages">${ic('chat-left-text')}View error details</a>`;
    m.side = { eyebrow: 'Planner', title: 'Waiting', sub: smart ? 'The interrupted session is not resumed automatically.' : 'The firmware calendar continues once the error is cleared.', tag: smartTag };
  } else if (S.hold) {
    if (S.hold.kind === 'weather') {
      m.title = 'Waiting out the weather'; m.tone = 'warn'; m.icon = 'cloud-lightning-rain';
      m.reason = `Parked at ${S.hold.at}: ${S.hold.why}. ${smart ? 'The watchdog resumes the session when conditions clear.' : 'The watchdog returns the mower to its calendar when conditions clear.'}`;
      m.actions = `<button class="button" data-act="cmd-resume">${ic('play')}Resume anyway</button>`;
    } else {
      m.title = 'Drying delay'; m.tone = 'warn'; m.icon = 'droplet-half';
      m.reason = `Weather has been clear since ${S.hold.clear}. ${smart ? `The mower resumes at ${S.hold.resume} after your 60 min drying delay.` : `After your 60 min drying delay (${S.hold.resume}) the mower returns to its calendar and mows only if a calendar window is open.`}`;
      m.actions = `<button class="button" data-act="cmd-resume">${ic('play')}Resume now</button>`;
    }
    m.side = smart ? { eyebrow: 'Interrupted session', title: 'Planned until 13:15', sub: `Mowed ${dur(sessInfo().mow)} so far. A make-up session is planned if the window runs out.`, tag: smartTag } : { eyebrow: 'Next firmware start', title: nx ? nx.title : 'None', sub: 'The calendar decides what happens next. No make-up session is added.', tag: smartTag };
  } else {
    m.title = S.plannerPaused ? 'Parked at home' : (S.battery < 100 ? 'Charging at home' : 'Parked at home');
    if (S.plannerPaused) m.reason = 'Parked until you resume. The planner will not start sessions in the meantime.';
    else m.reason = smart ? (S.plan === 'ok' ? 'Today\'s mowing is complete. The planner starts the next session when conditions are suitable.' : 'No session is running.') : 'The mower follows its firmware calendar.';
    const mowDisabled = pending() ? 'disabled' : '';
    m.actions = S.plannerPaused
      ? `<button class="button primary" data-act="cmd-resume">${ic('play')}Resume</button>`
      : `<span class="actions"><select aria-label="Quick-start duration" id="qs-dur" class="button" style="padding:0 10px"><option value="30">30 min</option><option value="60">1 hour</option><option value="120" selected>2 hours</option><option value="180">3 hours</option></select><button class="button primary" data-act="cmd-mow-quick" ${mowDisabled}>${ic('play-fill')}Mow now</button></span>`;
    m.actions += `<a class="button" href="#control" aria-label="All mower controls">${ic('three-dots')}<span class="sr-only">All controls</span></a>`;
    m.side = idleNext();
  }
  return m;
}
