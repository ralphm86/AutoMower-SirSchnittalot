'use strict';
/* Concept only: chrome, Overview, Control, commands, dialogs, routing. */

const VIEWS = ['overview', 'control', 'planning', 'activity', 'settings'];
const NAV = [['overview', 'Overview', 'grid-1x2'], ['control', 'Control', 'sliders2'], ['planning', 'Planning', 'calendar3'], ['activity', 'Activity', 'clock-history'], ['settings', 'Settings', 'gear']];
let R = { view: 'overview', sub: null, arg: null };
let lastView = null;
let DLG_RUN = null;

// ---------- feedback ----------
function announce(t) { const a = $('#announcer'); a.textContent = ''; setTimeout(() => { a.textContent = t; }, 50); }
function toast(t, bad) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = t;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}
function logEvent(src, icon, text) { S.log.unshift({ when: (S.today === 0 ? 'Mon ' : 'Wed ') + S.now, src, icon, text }); }
const banner = (tone, icon, body, actions) => `<div class="banner ${tone}" ${tone === 'bad' ? 'role="alert"' : ''}>${ic(icon)}<div class="grow">${body}${actions ? `<div class="actions">${actions}</div>` : ''}</div></div>`;

// ---------- chrome ----------
function renderChrome() {
  $('#nav').innerHTML = NAV.map(([id, l, i]) => `<a href="#${id}" ${R.view === id ? 'aria-current="page"' : ''}>${ic(i)}<span>${l}</span>${id === 'activity' && S.error ? '<span class="nav-dot" role="img" aria-label="Active error"></span>' : ''}</a>`).join('');
  const cm = {
    connected: ['ok', 'bluetooth', 'Connected'],
    disconnected: [S.firstRun ? '' : 'bad', 'bluetooth', S.firstRun ? 'No mower set up' : (S.winter ? 'Not connected (paused for winter)' : 'Not connected')],
    reconnecting: ['warn', 'arrow-repeat', 'Reconnecting'], connecting: ['warn', 'arrow-repeat', 'Connecting'], scanning: ['info', 'search', 'Scanning'],
  }[S.conn];
  let chips = `<span class="chip ${cm[0]}">${ic(cm[1])}${cm[2]}</span>`;
  if (S.conn !== 'connected' && S.fresh === 'stale' && !S.firstRun) chips += `<span class="chip warn">${ic('clock-history')}Last known data</span>`;
  chips += `<span class="chip ${S.mode === 'smart' ? 'info' : ''}">${ic(S.mode === 'smart' ? 'stars' : 'calendar-week')}${S.mode === 'smart' ? 'Smart mode' : 'Classic mode'}</span>`;
  if (S.winter) chips += `<span class="chip info">${ic('snow')}Winter mode</span>`;
  chips += `<span class="chip demo">DEMO · SIMULATED</span>`;
  $('#chips').innerHTML = chips;
  $('#breadcrumb').textContent = NAV.find(n => n[0] === R.view)[1];
  $('#sidebar-bottom').innerHTML = S.conn === 'connected' ? `<p><span class="chip ok">${ic('bluetooth')}Connected</span></p><p style="margin-top:8px"><strong>Demo Mower</strong></p><small class="muted">Automower 450X · Bluetooth</small>` : (S.firstRun ? '<p><strong>No mower yet</strong></p><small class="muted">Set one up in Settings</small>' : `<p><strong>Demo Mower</strong></p><small class="muted">${cm[2]}</small>`);
  document.body.classList.toggle('winter', S.winter);
  renderSnow();
}
function renderSnow() {
  const sn = $('#snow'); const on = S.winter && S.snow && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!on) { sn.innerHTML = ''; return; }
  if (sn.childElementCount) return;
  sn.innerHTML = Array.from({ length: 40 }, (_, i) => `<i style="left:${(i * 37) % 100}%;animation-duration:${8 + (i * 7) % 9}s;animation-delay:-${(i * 3) % 10}s;opacity:${0.5 + (i % 5) / 10}"></i>`).join('');
}
function renderBanners() {
  let h = ''; const v = R.view;
  if (S.advice === 'enter') h += banner('', 'snow', '<strong>Winter is approaching.</strong> No useful mowing sessions were found for the next 14 days and nights fall below 0 °C. Entering winter mode is your decision; nothing changes until you confirm.', `<button class="button primary small" data-act="winter-enter">Review and enter winter mode</button><button class="button small" data-act="advice-later">Later</button>`);
  if (S.advice === 'end') h += banner('ok', 'sun', '<strong>Growth is possible again.</strong> The growth model and forecast suggest mowing can resume. Winter mode stays on until you end it.', `<button class="button primary small" data-act="winter-leave">End winter mode</button><button class="button small" data-act="advice-later">Later</button>`);
  if (S.error && v !== 'overview' && !(v === 'activity' && R.sub === 'messages')) h += banner('bad', 'exclamation-octagon', `<strong>The mower needs attention:</strong> ${S.error.name} since ${S.error.since}.`, `<a class="button small" href="#activity/messages">Error details</a>`);
  if (S.conn !== 'connected' && !S.firstRun && !S.winter && v !== 'overview' && v !== 'settings') h += banner('warn', 'bluetooth', '<strong>Not connected.</strong> Values shown are last known and commands are unavailable.', `<a class="button small" href="#settings">Connection settings</a>`);
  if (S.weather === 'unavailable' && ['overview', 'planning'].includes(v)) h += banner('warn', 'cloud-slash', '<strong>Weather data unavailable.</strong> Last forecast fetched 11:05. Planning keeps the stored forecast and the watchdog cannot check conditions.');
  if (S.mode === 'classic' && S.cal === 'placeholder' && ['overview', 'planning'].includes(v)) h += banner('warn', 'exclamation-triangle', '<strong>Your calendar has not been restored.</strong> The mower currently holds only the planner\'s placeholder task, so it will not start by itself.', `<a class="button small" href="#planning/calendar">Review and save a calendar</a>`);
  $('#banners').innerHTML = h;
}

// ---------- overview ----------
const mowedToday = () => (S.today === 0 ? 90 : 0) + (S.session ? S.session.mow : 0);
const owed = () => (S.today === 0 ? 1.7 : 3.1) - (S.today === 2 && S.session ? S.session.mow / 60 : 0);
function wd() {
  const c = cfgSaved;
  if (S.winter) return { icon: 'snow', t: 'Watchdog paused', p: 'Winter mode pauses weather monitoring.', off: true };
  if (!c.wdOn) return { icon: 'shield-slash', t: 'Weather watchdog off', p: 'Disabled in Planning rules.', off: true };
  if (S.weather === 'unavailable') return { icon: 'cloud-slash', t: 'Cannot check conditions', p: 'Weather data unavailable; last successful check 11:05.', off: true };
  if (S.hold && S.hold.kind === 'weather') return { icon: 'cloud-lightning-rain', t: 'Weather hold', p: `Parked at ${S.hold.at}. Next check ${m2t(t2m(S.now) + c.wdEvery)}.` };
  if (S.hold) return { icon: 'droplet-half', t: 'Drying delay', p: `Resumes at ${S.hold.resume}.` };
  const last = t2m(S.now) - 2;
  return { icon: 'shield-check', t: 'Weather watchdog monitoring', p: `Last check ${m2t(last)} · no restrictions · next ${m2t(last + c.wdEvery)}` };
}
function protections() {
  const c = cfgSaved, smart = S.mode === 'smart';
  if (!smart) return `<div class="protection off">${ic('info-circle')}<div><strong>Planner protections are inactive</strong><p>They apply in Smart mode only. The firmware calendar does not check weather before a start; the weather watchdog still parks a running mower in bad weather when it is on.</p></div></div>`;
  const row = (on, icn, t, p) => `<div class="protection ${on ? '' : 'off'}">${ic(on ? icn : 'dash-circle')}<div><strong>${t}${on ? '' : ' is off'}</strong><p>${p}</p></div></div>`;
  return row(c.daylight, 'sunset', 'Daylight-only mowing', c.daylight ? 'Window ends 16:00 today; sunset is 16:11.' : 'Mowing may be planned in the dark.')
    + row(c.dew, 'droplet', 'Dew avoidance', c.dew ? (c.dewAuto ? `Start is delayed up to ${c.dewHours} h after sunrise, estimated from the forecast.` : `Start is delayed ${c.dewHours} h after sunrise.`) : 'Sessions may start on wet grass.')
    + row(c.heat, 'thermometer-sun', 'Heat protection', c.heat ? `No mowing above ${c.heatTemp} °C.` : 'Midday heat is not restricted.');
}
function renderOverview() {
  const m = statusModel(), smart = S.mode === 'smart', lk = S.conn !== 'connected';
  const dateLabel = `${WEEK[S.today][2]}, ${WEEK[S.today][1]} November 2026`;
  const fresh = S.fresh === 'live' && !lk ? 'Updated just now' : `Last known values from ${S.lastSeen}`;
  let h = `<div class="page-title"><div><h1 id="h-overview" tabindex="-1">Your garden, at a glance.</h1><p class="subtitle">${dateLabel} · ${fresh}</p></div><button class="button" data-act="refresh" ${lk ? 'disabled' : ''}>${ic('arrow-clockwise')}Refresh</button></div>`;
  h += `<div class="status-band tone-${m.tone || 'ok'}"><div><div class="eyebrow">Demo Mower · Automower 450X</div><div class="live-status"><span class="status-symbol">${ic(m.icon)}</span><h2>${m.title}</h2></div><p class="status-description">${m.reason}</p><div class="actions">${m.actions}</div>${cmdBrief()}</div>`;
  h += `<div class="session-info"><div class="eyebrow">${m.side.eyebrow}</div><strong>${m.side.title}</strong><p>${m.side.sub}</p>${m.side.tag ? `<span class="tag">${m.side.tag}</span>` : ''}</div></div>`;
  if (S.firstRun) return h + `<div class="empty" style="margin-top:20px">${ic('plug')}<h2>Nothing to show yet</h2><p>Status, planning and activity appear here after your first connection. Scanning and pairing live in Settings.</p><a class="button primary" href="#settings">Go to connection setup</a></div>`;
  const batt = S.battery;
  const fixed = !S.adaptive;
  const card2 = smart || true ? (fixed
    ? `<div class="metric"><h3>Mowing today</h3><strong>${dur(mowedToday())}</strong><div class="meter" aria-hidden="true"><span style="width:${Math.min(100, mowedToday() / 90 * 100)}%"></span></div><small>${mowedToday() >= 90 ? 'Daily target of 1 h 30 m reached' : 'of 1 h 30 m daily target'}${lk ? ' · last known' : ''}</small></div>`
    : `<div class="metric"><h3>Mowing owed</h3><strong>${owed().toFixed(1)} h</strong><div class="meter blue" aria-hidden="true"><span style="width:${Math.min(100, owed() / 2.3 * 100)}%"></span></div><small>Session due at 2.3 h · adaptive${lk ? ' · last known' : ''}</small></div>`) : '';
  const health = lk ? `<strong>Unknown</strong><small>Cannot be checked while disconnected</small>` : (S.error ? `<strong style="color:var(--red)">Needs attention</strong><small><a class="text-link" href="#activity/messages">${S.error.name} · details</a></small>` : `<strong style="color:var(--green-dark)">All clear</strong><small>No active errors</small>`);
  h += `<div class="metrics"><div class="metric"><h3>Battery</h3><strong>${batt}%</strong><div class="meter" aria-hidden="true"><span style="width:${batt}%"></span></div><small>${lk ? 'Last known' : (S.activity === 'mowing' ? 'In use' : S.activity === 'charging' ? 'Charging' : batt === 100 ? 'Fully charged' : '')}</small></div>${card2}<div class="metric"><h3>Mower health</h3>${health}</div><div class="metric"><h3>Data</h3><strong>${lk ? 'Last known' : 'Live'}</strong><small>${lk ? 'From ' + S.lastSeen : 'Updated just now'}</small></div></div>`;
  // coming up
  const days = planDays().filter(d => d.i > S.today || (d.i === S.today && !d.slot)).slice(0, 3);
  const stale = planStale();
  const rows = S.plan === 'invalid' ? (S.winter ? `<div class="row"><div class="row-main"><strong>Planning is paused for winter</strong><small>Sessions resume when you leave winter mode.</small></div></div>` : `<div class="row"><div class="row-main"><strong>No plan yet</strong><small>${LOC.lat == null ? 'Planning needs a location.' : 'Planning needs a valid mowing window.'}</small></div><a class="button small" href="#${LOC.lat == null ? 'settings' : 'planning/rules'}">${LOC.lat == null ? 'Open settings' : 'Open rules'}</a></div>`) : days.map(d => {
    const c = CODES[d.code];
    return `<a class="row" href="#planning/week/${d.i}"><div class="day-stamp"><small>${d.w[0].toUpperCase()}</small><strong>${d.w[1]}</strong></div><div class="row-main"><strong>${d.slot ? `${d.slot.s} – ${d.slot.e}` : c.tag}</strong><small>${d.slot ? (d.slot.mow ? `${dur(d.slot.mow)} mowing · charging included` : 'Firmware start') : d.reason}</small></div><span class="tag ${d.slot ? '' : c.cls}">${ic(c.icon)}${stale ? 'Outdated' : c.tag}</span></a>`;
  }).join('');
  h += `<div class="cols"><section aria-labelledby="h-coming"><div class="card-title"><h2 id="h-coming">Coming up</h2><a class="text-link" href="#planning">Full plan</a></div><div class="list">${rows}</div></section>`;
  const w = FC[S.today];
  const cond = S.weather === 'unavailable' ? `<div class="banner warn">${ic('cloud-slash')}<div class="grow"><strong>Weather unavailable</strong><p class="small">Last fetched 11:05 (3 h ago).</p></div></div>` : `<div class="weather-line">${ic(w.icon)}<div><strong>${w.hi} °C</strong><p class="small muted">${w.txt} · dry until tonight</p></div></div><p class="small muted">${ic('droplet')} ${w.rain.toFixed(1)} mm/h &nbsp; ${ic('wind')} ${w.wind} m/s · updated 2 minutes ago</p>`;
  const wdv = wd();
  h += `<section aria-labelledby="h-cond"><div class="card-title"><h2 id="h-cond">Garden conditions</h2><span class="tag gray">${ic('geo-alt')}${LOC.name ? LOC.name.split(',')[0] : 'No location'}</span></div>${cond}<div class="protection ${wdv.off ? 'off' : ''}">${ic(wdv.icon)}<div><strong>${wdv.t}</strong><p>${wdv.p}</p></div></div>${protections()}</section></div>`;
  h += `<section class="recent" aria-labelledby="h-latest"><div class="card-title"><h2 id="h-latest">Latest activity</h2><a class="text-link" href="#activity/events">All activity</a></div>${S.log.slice(0, 2).map(e => `<div class="event-line"><time>${e.when}</time>${ic(e.icon)}<span>${e.text} <span class="muted">· ${e.src}</span></span></div>`).join('')}</section>`;
  return h;
}

// ---------- command lifecycle ----------
function cmdBrief() {
  if (!S.cmd) return '';
  return `<div style="margin-top:14px">${cmdStatus()}</div>`;
}
function cmdStatus() {
  const c = S.cmd; if (!c) return '';
  if (c.stage === 'failed') return `<div class="banner bad" role="alert">${ic('x-octagon')}<div class="grow"><strong>${c.label}: not completed.</strong> ${c.err}<div class="actions"><button class="button small" data-act="cmd-retry" ${canCmd() ? '' : 'disabled'}>Retry with the same settings</button><button class="button small" data-act="cmd-dismiss">Dismiss</button></div></div></div>`;
  const order = ['sending', 'accepted', 'observed', 'done'];
  const idx = order.indexOf(c.stage);
  const label = { sending: 'Sending to the mower…', accepted: 'Accepted by the mower. Waiting for it to confirm…', observed: c.final ? 'Confirmed by the mower.' : 'The mower confirmed the new state.', done: c.final || 'Done' }[c.stage];
  return `<div class="small" aria-live="polite"><strong>${c.label}</strong><br><span class="muted">${label}</span><div class="legend" style="margin-top:4px"><span>${idx >= 0 ? ic('check2') : ''} Sent</span><span>${idx >= 1 ? ic('check2') : ic('circle')} Accepted</span><span>${idx >= 2 ? ic('check2') : ic('circle')} Observed</span></div></div>`;
}
const EFFECT = {
  mow(min) {
    S.plannerPaused = null; S.hold = null; S.activity = 'mowing';
    S.session = { kind: S.mode === 'smart' ? 'manual' : 'override', start: S.now, end: m2t(t2m(S.now) + min), mow: 0, chg: 0 };
  },
  pause() { S.activity = 'paused'; if (S.mode === 'smart') S.plannerPaused = { kind: 'pause' }; },
  park() { S.activity = 'returning'; if (S.mode === 'smart') S.plannerPaused = { kind: 'park' }; },
  parkfor(min) { S.activity = 'returning'; if (S.mode === 'smart') S.plannerPaused = { kind: 'parkfor', until: m2t(t2m(S.now) + min) }; },
  skip() { S.activity = 'returning'; S.session = null; },
  resume() {
    S.hold = null;
    if (S.mode === 'smart') {
      const had = S.plannerPaused; S.plannerPaused = null;
      if (S.session && ['paused', 'returning', 'parked'].includes(S.activity) && (had || S.activity === 'paused' || S.session.interrupted)) { S.activity = 'mowing'; S.session.interrupted = false; }
      else if (S.activity === 'paused') S.activity = 'parked';
    } else { S.activity = S.session ? 'mowing' : 'parked'; }
  },
};
async function runCmd(kind, arg) {
  if (pending() || !canCmd()) return;
  const labels = { mow: `Mow for ${dur(arg)}`, pause: 'Pause', park: S.mode === 'smart' ? 'Return home until resumed' : 'Park until resumed', parkfor: `Park for ${dur(arg)}`, skip: S.mode === 'smart' ? 'Skip this session' : 'Park until next scheduled start', resume: 'Resume' };
  S.cmd = { kind, arg, label: labels[kind], stage: 'sending' };
  render(); announce(`${labels[kind]}: sending`);
  await wait(700);
  const out = S.nextCmd; S.nextCmd = 'ok';
  if (out === 'reject' || out === 'drop') {
    S.cmd = { ...S.cmd, stage: 'failed', err: out === 'reject' ? 'The mower rejected the command because it is busy. Nothing changed.' : 'The connection dropped while sending. The outcome is unknown, so check the mower before retrying.' };
    if (out === 'drop') { S.conn = 'disconnected'; S.fresh = 'stale'; S.lastSeen = S.now; logEvent('Connection', 'bluetooth', 'Connection lost while sending a command'); }
    logEvent('Command', 'terminal', `${labels[kind]}: failed`);
    render(); announce(`${labels[kind]} failed`); return;
  }
  if (!S.cmd) return; // scenario was switched while the command was in flight
  S.cmd.stage = 'accepted'; render(); await wait(900);
  if (!S.cmd) return;
  EFFECT[kind](arg); S.cmd.stage = 'observed';
  logEvent('Command', 'terminal', `${labels[kind]}: confirmed by the mower`);
  render(); announce(`${labels[kind]}: confirmed`);
  if (['park', 'parkfor', 'skip'].includes(kind) && S.activity === 'returning') {
    await wait(1800);
    if (S.activity === 'returning' && S.cmd && S.cmd.kind === kind) { S.activity = 'parked'; S.cmd.stage = 'done'; S.cmd.final = 'The mower has arrived at the station.'; render(); announce('The mower has arrived at the station'); }
  }
}
function validMin(v) { return Number.isInteger(v) && v >= 15 && v <= 720; }
Object.assign(ACTIONS, {
  'cmd-pause': () => runCmd('pause'),
  'cmd-park': () => runCmd('park'),
  'cmd-skip': () => runCmd('skip'),
  'cmd-resume': () => runCmd('resume'),
  'cmd-mow-quick': () => { const v = parseInt($('#qs-dur').value, 10); runCmd('mow', v); },
  'cmd-mow': () => { const v = Number(S.mowMin ?? 60); if (!validMin(v)) { S.mowErr = 'Enter whole minutes from 15 to 720 (12 h).'; render(); return; } S.mowErr = null; runCmd('mow', v); },
  'cmd-parkfor': () => { const v = Number(S.parkMin ?? 60); if (!validMin(v)) { S.parkErr = 'Enter whole minutes from 15 to 720 (12 h).'; render(); return; } S.parkErr = null; runCmd('parkfor', v); },
  'cmd-retry': () => { const c = S.cmd; if (c) { S.cmd = null; runCmd(c.kind, c.arg); } },
  'cmd-dismiss': () => { S.cmd = null; render(); },
  refresh: () => { toast('Status refreshed'); announce('Status refreshed'); },
  reconnect: async () => { S.conn = 'reconnecting'; render(); await wait(1400); if (S.nextConnect === 'fail') { S.conn = 'disconnected'; S.nextConnect = 'ok'; toast('Reconnect failed. The mower did not answer.', true); } else { S.conn = 'connected'; S.fresh = 'live'; S.lastSeen = null; logEvent('Connection', 'bluetooth', 'Reconnected'); toast('Reconnected'); } render(); },
  'sync-clock': () => { logEvent('Command', 'terminal', 'Mower clock synchronised'); toast('Mower clock synchronised'); },
  'advice-later': () => { S.advice = null; render(); announce('Reminder dismissed. Winter mode was not changed.'); },
});

// ---------- control ----------
function renderControl() {
  const av = nextAvail(), smart = S.mode === 'smart';
  const why = k => (av[k].ok ? '' : `<span class="small muted">Unavailable: ${av[k].why}.</span>`);
  const btn = (k, act, icn, label, cls = '') => `<button class="button ${cls}" data-act="${act}" ${av[k].ok ? '' : 'disabled'}>${ic(icn)}${label}</button>`;
  const row = (title, effect, controls, k) => `<div class="row" style="align-items:flex-start;flex-wrap:wrap"><div class="row-main" style="min-width:240px"><strong>${title}</strong><small>${effect}</small>${why(k)}</div><div class="actions">${controls}</div></div>`;
  const resumeText = S.hold ? 'Overrides the weather hold and resumes now.' : (smart ? (S.activity === 'paused' && S.session ? `Clears the pause and continues the current session until ${sessInfo().end}.` : (S.plannerPaused ? `Clears the pause. The mower waits for the next planned session${lastNext() ? ' (' + lastNext().title + ')' : ''}.` : 'Nothing is paused.')) : 'Clears the override and returns to AUTO: the mower follows its calendar.');
  const lim = 'Whole minutes, 15 to 720 (12 h).';
  let h = `<div class="page-title"><div><h1 id="h-control" tabindex="-1">Mower control</h1><p class="subtitle">Demo Mower · ${smart ? 'Smart mode' : 'Classic mode'}</p></div></div>`;
  if (S.cmd) h += `<div class="card" style="margin-bottom:16px" role="region" aria-label="Command status">${cmdStatus()}</div>`;
  h += `<div class="card"><h2>Manual mowing</h2><p class="muted small" style="margin:6px 0 12px">${smart ? 'Starts a manual session. When it ends the mower returns home and the planner continues with the next planned session. Any pause is cleared.' : 'Sends a firmware override for the chosen time. Your weekly calendar is not changed.'}</p><div class="field-grid" style="align-items:start"><label class="field">Duration (minutes)<input type="number" inputmode="numeric" step="5" data-bind="S.mowMin" data-type="number" value="${S.mowMin ?? 60}" ${S.mowErr ? 'aria-invalid="true" aria-describedby="mow-err"' : 'aria-describedby="mow-hint"'} id="mow-min"><span class="hint" id="mow-hint">${lim}</span>${S.mowErr ? `<span class="error" id="mow-err">${S.mowErr}</span>` : ''}</label><div style="align-self:end">${btn('mow', 'cmd-mow', 'play-fill', 'Start mowing', 'primary')}${why('mow')}</div></div></div>`;
  h += `<div class="card"><h2>Pause, park and resume</h2><p class="muted small" style="margin:6px 0 12px">Each action states whether the planner keeps starting sessions and how the mower restarts.</p><div class="list">`;
  h += row('Pause', smart ? 'Stops the mower where it is. <b>Planner:</b> skips sessions until you press Resume. <b>Restart:</b> manual.' : 'Sends the firmware pause. <b>Restart:</b> manual, with Resume.', btn('pause', 'cmd-pause', 'pause-fill', 'Pause'), 'pause');
  h += row(smart ? 'Return home until resumed' : 'Park until resumed', smart ? 'Sends the mower to the station. <b>Planner:</b> skips sessions until you press Resume. <b>Restart:</b> manual.' : 'HOME mode: the mower stays at the station. <b>Restart:</b> manual, with Resume.', btn('park', 'cmd-park', 'house-down', smart ? 'Return home' : 'Park'), 'park');
  h += row('Park for a set time', smart ? 'Sends the mower home. <b>Planner:</b> skips sessions for this time, then clears the pause by itself. <b>Restart:</b> automatic.' : 'Firmware park override for this time. <b>Restart:</b> automatic.', `<label class="field" style="min-width:150px"><span class="sr-only">Park duration in minutes</span><input type="number" step="5" data-bind="S.parkMin" data-type="number" value="${S.parkMin ?? 60}" ${S.parkErr ? 'aria-invalid="true" aria-describedby="park-err"' : ''} id="park-min" style="margin-top:0">${S.parkErr ? `<span class="error" id="park-err">${S.parkErr}</span>` : '<span class="hint">minutes</span>'}</label>${btn('parkfor', 'cmd-parkfor', 'hourglass-split', 'Park')}`, 'parkfor');
  h += row(smart ? 'Skip this session' : 'Park until next scheduled start', smart ? 'Ends only the current session. <b>Planner:</b> keeps running. <b>Restart:</b> automatic at the next planned session.' : 'Sends the mower home now. <b>Restart:</b> automatic at the next calendar start.', btn('skip', 'cmd-skip', 'skip-forward', smart ? 'Skip session' : 'Park'), 'skip');
  h += row('Resume', resumeText, btn('resume', 'cmd-resume', 'play', 'Resume', 'primary'), 'resume');
  h += `</div></div>`;
  h += `<div class="card" style="margin-top:16px"><h2>Maintenance</h2><div class="stack" style="margin-top:10px">`;
  h += `<div><button class="button" data-act="sync-clock" ${canCmd() ? '' : 'disabled'}>${ic('clock')}Synchronise mower clock</button><p class="small muted" style="margin-top:4px">Sets the mower clock to this device's time (CET).</p></div><div><a class="button" href="#activity/performance">${ic('wrench')}Blade usage and statistics</a><p class="small muted" style="margin-top:4px">Resets are explicit actions in Activity › Performance.</p></div></div></div>`;
  return h;
}

// ---------- dialogs ----------
let DLG_OPENER = null;
// The opener is re-rendered while the dialog is open, so the browser cannot restore focus itself.
function openDlg(html) { $('#dlg-body').innerHTML = html; const d = $('#dlg'); if (!d.open) { DLG_OPENER = keyOf(document.activeElement); d.showModal(); } }
document.addEventListener('close', ev => { if (ev.target.id !== 'dlg') return; const el = DLG_OPENER && $(DLG_OPENER); DLG_OPENER = null; if (el) el.focus(); }, true);
function confirmDlg({ title, body, confirm, danger, run }) {
  DLG_RUN = run;
  openDlg(`<h2 id="dlg-title">${title}</h2>${body}<div class="actions"><button class="button" data-act="dlg-close">Cancel</button><button class="button ${danger ? 'danger' : 'primary'}" data-act="dlg-ok">${confirm}</button></div>`);
}
Object.assign(ACTIONS, {
  'dlg-close': () => $('#dlg').close(),
  'dlg-ok': () => { $('#dlg').close(); const r = DLG_RUN; DLG_RUN = null; if (r) r(); },
  'winter-enter': () => confirmDlg({
    title: 'Enter winter mode?',
    body: '<p>This pauses the app for the season. It does not stop or store the mower.</p><ul><li>Planning and the weather watchdog stop.</li><li>Auto-reconnect pauses, so the app will not reach the mower.</li><li>Planned sessions are cleared.</li><li>The mower\'s own firmware calendar is <strong>not</strong> changed.</li></ul><p class="muted small">You can leave winter mode at any time in Settings.</p>',
    confirm: 'Enter winter mode',
    run: () => { Object.assign(S, { winter: true, winterSince: '16 Nov 2026', advice: null, conn: 'disconnected', fresh: 'stale', lastSeen: S.now, plan: 'invalid' }); logEvent('Planner', 'snow', 'Winter mode started'); render(); announce('Winter mode started. Planning, watchdog and auto-reconnect are paused.'); },
  }),
  'winter-leave': () => confirmDlg({
    title: 'Leave winter mode?',
    body: '<p>Planning, the weather watchdog and auto-reconnect restart. The app reconnects first; a new plan is calculated afterwards, so sessions appear only once they exist.</p>',
    confirm: 'Leave winter mode',
    run: async () => { Object.assign(S, { winter: false, advice: null, conn: 'reconnecting', plan: 'ok' }); logEvent('Planner', 'sun', 'Winter mode ended'); render(); announce('Winter mode ended. Reconnecting.'); await wait(1600); S.conn = 'connected'; S.fresh = 'live'; S.lastSeen = null; render(); announce('Reconnected. The planner is calculating a new plan.'); },
  }),
});

// mode switch (US-06): every step is verified before the mode changes
const MS = { to: null, choice: 'restore' };
function openModeSwitch() {
  const toSmart = S.mode === 'classic';
  MS.to = toSmart ? 'smart' : 'classic'; MS.choice = S.calSaved ? 'restore' : 'review';
  if (toSmart) {
    openDlg(`<h2 id="dlg-title">Let the planner take over?</h2><p>Smart mode replaces your mower's weekly calendar with a placeholder task and starts sessions with direct commands.</p><ol class="steps"><li>A recoverable copy of your current calendar (${SAVED_CALENDAR.length} tasks) is saved first.</li><li>The placeholder is written to the mower.</li><li>The mower is read back to verify.</li><li>The planner starts.</li></ol><p class="muted small">While Smart mode is on, calendar editing is locked. Switching back lets you restore the copy.</p><div class="actions"><button class="button" data-act="dlg-close">Cancel</button><button class="button primary" data-act="ms-run">Save copy and enable Smart</button></div>`);
  } else {
    openDlg(`<h2 id="dlg-title">Return to Classic mode?</h2><p>The planner stops and the mower follows its own calendar again. Choose what the calendar should be:</p><fieldset style="border:0;padding:0;margin:10px 0"><legend class="sr-only">Calendar after switching</legend><label class="check"><input type="radio" name="ms" value="restore" ${S.calSaved ? 'checked' : 'disabled'} data-act="ms-choice" data-arg="restore"><span>Restore my saved calendar<small>${S.calSaved ? `${SAVED_CALENDAR.length} tasks, saved 6 Nov 2026 08:12 when Smart mode was enabled.` : 'No saved copy exists, so this option is unavailable.'}</small></span></label><label class="check"><input type="radio" name="ms" value="review" ${S.calSaved ? '' : 'checked'} data-act="ms-choice" data-arg="review"><span>Review and save a new calendar<small>The mower keeps only the placeholder until you save one. It will not start by itself in the meantime.</small></span></label></fieldset><div class="actions"><button class="button" data-act="dlg-close">Cancel</button><button class="button primary" data-act="ms-run">Switch to Classic</button></div>`);
  }
}
async function runModeSwitch() {
  const fail = S.switchFail; const toSmart = MS.to === 'smart';
  const steps = toSmart ? [['backup', 'Save a copy of your calendar'], ['write', 'Write the placeholder to the mower'], ['verify', 'Read the mower back to verify'], ['start', 'Start the planner']]
    : [['stop', 'Stop the planner'], ['write', MS.choice === 'restore' ? 'Restore your saved calendar' : 'Keep the placeholder for review'], ['verify', 'Read the mower back to verify']];
  const st = steps.map(([k, t]) => ({ k, t, s: 'wait' }));
  const draw = (extra = '') => openDlg(`<h2 id="dlg-title">${toSmart ? 'Enabling Smart mode' : 'Returning to Classic mode'}</h2><ol class="steps" aria-live="polite">${st.map(x => `<li data-s="${x.s}">${x.t}${x.s === 'done' ? ' (done)' : x.s === 'run' ? '…' : x.s === 'fail' ? ' (failed)' : ''}</li>`).join('')}</ol>${extra}`);
  S.switchFail = 'none';
  for (const x of st) {
    x.s = 'run'; draw(); await wait(850);
    if (fail === x.k) {
      x.s = 'fail';
      const copy = toSmart && x.k !== 'backup';
      const msg = toSmart
        ? (x.k === 'backup' ? '<p><strong>Your calendar could not be saved.</strong> Nothing was changed on the mower. You are still in Classic mode.</p>' : `<p><strong>The mower could not ${x.k === 'write' ? 'be updated' : 'be verified'}.</strong> Your calendar copy is saved. The mower's calendar may be incomplete, so you are still in Classic mode until this succeeds.</p>`)
        : `<p><strong>The mower could not ${x.k === 'stop' ? 'stop the planner' : x.k === 'write' ? 'take the calendar' : 'be verified'}.</strong> You are still in Smart mode and nothing was reported as changed.</p>`;
      draw(`${msg}<div class="actions"><button class="button" data-act="dlg-close">Close</button>${copy ? '<button class="button" data-act="ms-restore">Restore my saved calendar</button>' : ''}<button class="button primary" data-act="ms-retry">Retry</button></div>`);
      announce('Mode switch failed. You can retry or recover.');
      return;
    }
    x.s = 'done';
  }
  S.mode = toSmart ? 'smart' : 'classic';
  if (toSmart) { S.cal = 'placeholder'; S.calSaved = true; S.plan = 'ok'; } else { S.cal = MS.choice === 'restore' ? 'user' : 'placeholder'; S.plannerPaused = null; }
  logEvent('Planner', 'arrow-left-right', `Control mode changed to ${S.mode === 'smart' ? 'Smart' : 'Classic'} (verified)`);
  const review = !toSmart && MS.choice === 'review';
  draw(`<p><strong>Verified on the mower.</strong> ${toSmart ? 'The planner is in control; calendar editing is locked.' : review ? 'Only the placeholder is on the mower. Save a calendar to finish.' : 'Your saved calendar is back on the mower.'}</p><div class="actions">${review ? '<a class="button primary" href="#planning/calendar" data-act="dlg-close">Review calendar</a>' : '<button class="button primary" data-act="dlg-close">Done</button>'}</div>`);
  render(); announce(`Control mode is now ${S.mode}. Verified on the mower.`);
}
Object.assign(ACTIONS, {
  'mode-switch': openModeSwitch,
  'ms-choice': v => { MS.choice = v; },
  'ms-run': runModeSwitch,
  'ms-retry': runModeSwitch,
  'ms-restore': async () => { openDlg(`<h2 id="dlg-title">Restoring your calendar</h2><p aria-live="polite">Writing ${SAVED_CALENDAR.length} saved tasks to the mower…</p>`); await wait(1000); S.cal = 'user'; S.mode = 'classic'; logEvent('Planner', 'arrow-counterclockwise', 'Saved calendar restored'); openDlg(`<h2 id="dlg-title">Calendar restored</h2><p><strong>Verified on the mower.</strong> You are in Classic mode with your saved calendar.</p><div class="actions"><button class="button primary" data-act="dlg-close">Done</button></div>`); render(); },
});

// ---------- state switcher (concept only) ----------
function renderSwitcher() {
  const sel = (id, label, opts, val, fn) => `<label>${label}<select id="${id}" data-change="${fn}">${opts.map(([v, l]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const seg = (label, opts, val, fn) => `<div><span style="font-size:13px">${label}</span><div class="seg" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button data-act="${fn}" data-arg="${v}" aria-pressed="${v === val}">${l}</button>`).join('')}</div></div>`;
  $('#switcher-body').innerHTML = sel('sw-preset', 'Scenario', PRESETS.map(p => [p[0], p[1]]), S.preset, 'sw-preset')
    + seg('Control mode', [['smart', 'Smart'], ['classic', 'Classic']], S.mode, 'sw-mode')
    + seg('Planning model', [['fixed', 'Fixed target'], ['adaptive', 'Adaptive']], S.adaptive ? 'adaptive' : 'fixed', 'sw-model')
    + sel('sw-cmd', 'Next command', [['ok', 'Succeeds'], ['reject', 'Is rejected'], ['drop', 'Loses connection']], S.nextCmd, 'sw-nextcmd')
    + sel('sw-recalc', 'Next recalculation', [['ok', 'Finds sessions'], ['zero', 'Finds no sessions'], ['failed', 'Fails'], ['invalid', 'Invalid setup']], S.nextRecalc, 'sw-nextrecalc')
    + sel('sw-switch', 'Next mode switch', [['none', 'Succeeds'], ['backup', 'Fails saving copy'], ['stop', 'Fails stopping planner'], ['write', 'Fails writing calendar'], ['verify', 'Fails verification']], S.switchFail, 'sw-switchfail')
    + sel('sw-connect', 'Next connect attempt', [['ok', 'Succeeds'], ['fail', 'Fails']], S.nextConnect, 'sw-nextconnect')
    + '<p>Concept only. Values are illustrative; no real mower is controlled.</p>';
}
Object.assign(ACTIONS, {
  'sw-preset': v => { applyPreset(v); if (R.view === 'planning' && !['week', 'rules', 'calendar'].includes(R.sub)) R.sub = null; },
  'sw-mode': v => { S.mode = v; if (v === 'classic' && S.cal !== 'placeholder') S.cal = 'user'; if (v === 'smart') S.cal = 'placeholder'; S.preset = ''; },
  'sw-model': v => { S.adaptive = v === 'adaptive'; cfgSaved.adaptive = S.adaptive; CFG.adaptive = S.adaptive; },
  'sw-nextcmd': v => { S.nextCmd = v; },
  'sw-nextrecalc': v => { S.nextRecalc = v; },
  'sw-switchfail': v => { S.switchFail = v; },
  'sw-nextconnect': v => { S.nextConnect = v; },
});

// ---------- render + routing ----------
const keyOf = el => el && (el.id ? '#' + el.id : el.dataset && el.dataset.act ? `[data-act="${el.dataset.act}"]${el.dataset.arg ? `[data-arg="${el.dataset.arg}"]` : ''}` : el.dataset && el.dataset.bind ? `[data-bind="${el.dataset.bind}"]` : null);
function render(navigated) {
  const ae = document.activeElement, key = keyOf(ae);
  renderChrome(); renderBanners();
  VIEWS.forEach(v => { const el = $('#' + v); el.hidden = v !== R.view; });
  const fn = { overview: renderOverview, control: renderControl, planning: renderPlanning, activity: renderActivity, settings: renderSettings }[R.view];
  $('#' + R.view).innerHTML = fn();
  renderSwitcher();
  document.title = `${NAV.find(n => n[0] === R.view)[1]} | Sir Schnittalot concept`;
  if (navigated) { window.scrollTo(0, 0); const h = $('#h-' + R.view); if (h) h.focus({ preventScroll: true }); }
  else if (key) { const el = $(key); if (el) el.focus({ preventScroll: true }); }
}
function parseHash() {
  const p = location.hash.slice(1).split('/');
  R = { view: VIEWS.includes(p[0]) ? p[0] : 'overview', sub: p[1] || null, arg: p[2] || null };
}
window.addEventListener('hashchange', () => { const prev = R.view; parseHash(); render(prev !== R.view); });
const ROOTS = () => ({ S, CFG, LOC, CONNUI });
function setPath(path, val) { const [r, ...ks] = path.split('.'); let o = ROOTS()[r]; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = val; }
function readVal(el) { return el.type === 'checkbox' ? el.checked : el.dataset.type === 'bool' ? el.value === 'true' : el.dataset.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value; }
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]'); if (!el || el.disabled) return;
  const f = ACTIONS[el.dataset.act]; if (!f) return;
  if (el.tagName === 'A') { /* let navigation proceed */ }
  const r = f(el.dataset.arg, el, ev);
  if (el.dataset.act.startsWith('sw-') || !['dlg-close', 'ms-choice'].includes(el.dataset.act)) { if (!(r instanceof Promise)) render(); else r.then(() => { }); }
});
document.addEventListener('input', ev => {
  const el = ev.target.closest('[data-bind]'); if (!el) return;
  setPath(el.dataset.bind, readVal(el));
  if (el.dataset.bind.startsWith('CFG.')) syncDirty();
});
// Updates the save controls in place; a re-render here would swallow a click on Save.
function syncDirty() {
  const d = dirty();
  $$('[data-act="rules-save"],[data-act="rules-discard"]').forEach(b => { b.disabled = !d; });
  const chip = $('#rules-chip'); if (chip) { chip.className = 'chip ' + (d ? 'warn' : 'ok'); chip.innerHTML = d ? `${ic('pencil')}Unsaved changes` : 'Saved'; }
}
document.addEventListener('change', ev => {
  const b = ev.target.closest('[data-bind]'); if (b) { setPath(b.dataset.bind, readVal(b)); if (b.type === 'checkbox' || b.tagName === 'SELECT') render(); }
  const c = ev.target.closest('[data-change]'); if (c) { ACTIONS[c.dataset.change](c.value); render(); }
});
window.addEventListener('DOMContentLoaded', () => { freshConfig(); applyPreset('idle'); parseHash(); render(false); });
