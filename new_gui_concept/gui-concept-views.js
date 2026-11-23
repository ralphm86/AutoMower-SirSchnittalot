'use strict';
/* Concept only: Planning, Activity, Settings. */

const TABS = (id, tabs, cur) => `<div class="subnav" role="tablist" aria-label="${id}">${tabs.map(([k, l]) => `<button role="tab" id="tab-${k}" aria-selected="${k === cur}" tabindex="${k === cur ? 0 : -1}" data-act="goto" data-arg="${id.toLowerCase()}/${k}">${l}</button>`).join('')}</div>`;
document.addEventListener('keydown', ev => {
  const t = ev.target.closest('[role="tab"]'); if (!t || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(ev.key)) return;
  ev.preventDefault();
  const all = $$('[role="tab"]', t.parentElement), i = all.indexOf(t);
  const n = ev.key === 'Home' ? all[0] : ev.key === 'End' ? all[all.length - 1] : all[(i + (ev.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]; n.focus(); n.click();
});
const clone = o => JSON.parse(JSON.stringify(o));
const calcAt = () => (S.plan === 'failed' || S.weather === 'unavailable') ? '08:05' : (S.today === 0 ? '14:05' : '08:05');
const TZ = 'CET (UTC+1)';

// ---------- planning ----------
function summary() {
  const u = upcoming(), mow = u.reduce((a, d) => a + (d.slot.mow || 0), 0), inProg = live() ? 1 : 0;
  if (S.plan === 'failed') return `<div class="plan-summary bad">${ic('x-octagon')}<div><strong>Recalculation failed at 14:05</strong><small>The weather service could not be reached. Showing the plan from 08:05, which may be out of date.</small><div class="actions" style="margin-top:8px"><button class="button small" data-act="recalc">Try again</button></div></div></div>`;
  if (S.weather === 'unavailable') return `<div class="plan-summary warn">${ic('cloud-slash')}<div><strong>Plan not refreshed: weather unavailable</strong><small>Showing the plan from 08:05 with stored forecast values.</small></div></div>`;
  if (S.plan === 'zero') return `<div class="plan-summary info">${ic('info-circle')}<div><strong>Calculated: no sessions in the next 7 days</strong><small>Each day shows its reason below. Calculated ${calcAt()} · ${TZ}.</small></div></div>`;
  if (S.mode === 'classic') return `<div class="plan-summary info">${ic('calendar-week')}<div><strong>${u.length} firmware starts in the next 7 days</strong><small>${u[0] ? `Next: ${dayName(u[0].i)}, ${u[0].slot.s}. ` : ''}The calendar does not check weather or growth. ${TZ}.</small></div></div>`;
  const stale = S.rulesChanged ? ' Rules changed since this plan was calculated; recalculate to apply them.' : '';
  return `<div class="plan-summary ${S.rulesChanged ? 'warn' : ''}">${ic(S.rulesChanged ? 'exclamation-triangle' : 'check2-circle')}<div><strong>${u.length} upcoming session${u.length === 1 ? '' : 's'} · ${dur(mow)} of mowing${inProg ? ' · 1 in progress' : ''}</strong><small>${u[0] ? `Next: ${dayName(u[0].i)}, ${u[0].slot.s}. ` : ''}Calculated ${calcAt()} · ${TZ}.${stale}</small></div></div>`;
}
function dayTile(d) {
  const past = d.i < S.today, today = d.i === S.today, c = CODES[d.code], stale = planStale() && !past;
  let body;
  const w = S.weather === 'unavailable' ? '—' : `${d.f.hi}° / ${d.f.lo}°`;
  if (d.code === 'done') body = `<div class="slot done"><strong>${ic('check2')} Completed</strong>${dur(90)} mowed</div>`;
  else if (today && S.session && d.slot) body = `<div class="slot ${S.session.interrupted || S.hold || ['paused', 'returning', 'error'].includes(S.activity) ? '' : 'live'}" ${S.session.interrupted || S.hold ? 'style="background:#fff3cf;border-color:#c89a1a"' : ''}><strong>${S.session.interrupted || S.hold || S.activity === 'error' ? 'Interrupted' : 'In progress'}</strong>${d.slot.s} – ${d.slot.e}</div>`;
  else if (d.slot) body = `<div class="slot"><strong>${d.slot.s} – ${d.slot.e}</strong>${d.slot.mow ? dur(d.slot.mow) + ' mowing' : 'Firmware start'}${stale ? '<br><em>Outdated</em>' : ''}</div>`;
  else body = `<div class="noslot">${ic(c.icon)} ${c.tag}</div>`;
  return `<div class="week-day ${today ? 'today' : ''} ${selDay() === d.i ? 'selected' : ''}"><button data-act="sel-day" data-arg="${d.i}" aria-pressed="${selDay() === d.i}" aria-label="${dayName(d.i)}${past ? ', past' : today ? ', today' : ''}"><span class="week-date"><span>${d.w[0].toUpperCase()}${today ? ' · today' : ''}</span><strong>${d.w[1]}</strong></span><div class="forecast-mini">${ic(d.f.icon)} ${w}</div>${body}</button></div>`;
}
function selDay() {
  if (R.arg != null && /^\d$/.test(R.arg)) return Number(R.arg);
  const u = upcoming()[0]; return S.selDay ?? (u ? u.i : S.today);
}
function dayDetail(d) {
  const c = CODES[d.code], f = d.f, past = d.i < S.today, cf = cfgSaved, smart = S.mode === 'smart';
  const kv = [];
  kv.push(['Decision', `<span class="tag ${d.slot ? '' : c.cls}">${ic(c.icon)}${c.tag}</span>${past ? ' <span class="tag gray">Past</span>' : ''}${planStale() && !past ? ' <span class="tag amber">Outdated</span>' : ''}`]);
  if (d.slot) { kv.push(['Session', `${d.slot.s} – ${d.slot.e}`]); if (d.slot.mow) { kv.push(['Mowing', dur(d.slot.mow)]); kv.push(['Charging', `about ${dur(d.slot.chg)} (1 stop)`]); } }
  kv.push(['Forecast', S.weather === 'unavailable' ? 'Unavailable (stored values not shown)' : `${f.hi}° / ${f.lo}° · rain ${f.rain.toFixed(1)} mm/h · wind ${f.wind} m/s · ${f.txt}`]);
  if (smart) {
    kv.push(['Thresholds', `min ${cf.minTemp} °C · max rain ${cf.maxRain} mm/h · max wind ${cf.maxWind} m/s`]);
    kv.push(['Lawn', S.adaptive ? `Adaptive: session due at 2.3 h owed` : `Fixed: ${dur(cf.target * 60)} target every ${cf.interval} days`]);
  }
  return `<div class="card detail-panel" role="region" aria-label="Details for ${dayName(d.i)}"><div class="card-title"><h2>${dayName(d.i)}</h2></div><p style="margin-bottom:10px">${d.reason}</p><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
}
function growthCards() {
  const cf = cfgSaved;
  const owedNow = owed();
  return `<div class="card"><div class="card-title"><h2>How sessions are decided</h2><span class="tag ${S.adaptive ? '' : 'gray'}">${S.adaptive ? 'Adaptive' : 'Fixed target'}</span></div>${S.adaptive
    ? `<div class="big-number">${owedNow.toFixed(1)} h <small>mowing owed</small></div><div class="meter blue"><span style="width:${Math.min(100, owedNow / 2.3 * 100)}%"></span></div><p class="small muted" style="margin-top:8px">A session is due at 2.3 h. The lawn grows about 0.7 h per day this week; the growth model controls the plan.</p>`
    : `<div class="big-number">${dur(cf.target * 60)} <small>per mowing day</small></div><p class="small muted" style="margin-top:8px">Mow every ${cf.interval} days, up to your daily target. Completed mowing is deducted from the target.</p><div class="banner" style="margin:12px 0 0">${ic('info-circle')}<div class="grow"><strong>Lawn growth estimate: ${owedNow.toFixed(1)} h owed</strong><p class="small">Information only. Adaptive mowing is off, so this does not influence the plan.</p></div></div>`}</div>`;
}
function weekTab() {
  const smart = S.mode === 'smart';
  if (S.winter) return `<div class="empty">${ic('snow')}<h2>Planning is paused for winter</h2><p>Planned sessions were cleared. Leave winter mode in Settings to plan again.</p><a class="button" href="#settings">Open season settings</a></div>`;
  if (smart && S.plan === 'invalid') return `<div class="empty">${ic('exclamation-triangle')}<h2>${LOC.lat == null ? 'Planning needs a location' : 'No plan calculated yet'}</h2><p>${LOC.lat == null ? 'Forecasts and daylight times need a location. Set it in Settings, then recalculate.' : 'Your location and rules are set. Calculate the first plan.'}</p>${LOC.lat == null ? '<a class="button primary" href="#settings">Set location</a>' : '<button class="button primary" data-act="recalc">Calculate plan</button>'}</div>`;
  if (S.plan === 'running') return `<div class="plan-summary info" role="status">${ic('arrow-repeat')}<div><strong>Recalculating…</strong><small>Fetching the forecast and evaluating the next 7 days.</small></div></div><div class="card"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div></div>`;
  const days = planDays(), sel = days[selDay()];
  let h = summary() + `<div class="week-grid" role="group" aria-label="Next seven days">${days.map(dayTile).join('')}</div>${dayDetail(sel)}`;
  if (smart) {
    h += `<div class="cols" style="margin-top:20px"><section class="card"><div class="card-title"><h2>Why this plan?</h2><span class="subtitle">Weather and growth decisions</span></div><table class="decision-table"><thead><tr><th>Day</th><th>Decision</th><th>Reason</th></tr></thead><tbody>${days.filter(d => d.i >= S.today).map(d => `<tr><td>${d.w[0]} ${d.w[1]}</td><td><span class="tag ${d.slot ? '' : CODES[d.code].cls}">${CODES[d.code].tag}</span></td><td>${d.reason}</td></tr>`).join('')}</tbody></table></section>${growthCards()}</div>`;
  } else h += `<div class="card" style="margin-top:20px"><h2>Classic mode</h2><p class="muted small" style="margin:6px 0 10px">The mower follows its own weekly calendar. Weather-aware decisions, growth and protections need Smart mode.</p><div class="actions"><button class="button" data-act="goto" data-arg="planning/calendar">${ic('calendar-week')}Edit calendar</button><button class="button primary" data-act="mode-switch">Enable Smart mode</button></div></div>`;
  return h;
}
const err = (k, e) => (e[k] ? `<span class="error" id="e-${k.replace(/\W/g, '_')}">${e[k]}</span>` : '');
function validateCfg(c) {
  const e = {};
  c.windows.forEach((w, i) => {
    if (!(w.s < w.e)) e[`windows.${i}`] = 'The window must end after it starts.';
    else if (!w.s.endsWith(':00') || !w.e.endsWith(':00')) e[`windows.${i}`] = 'Use whole hours.';
    else if (c.windows.some((o, j) => j < i && o.day === w.day && o.s < w.e && w.s < o.e)) e[`windows.${i}`] = 'Windows on the same day cannot overlap.';
  });
  if (!c.windows.length) e.windows = 'Add at least one mowing window.';
  if (c.minDur > c.maxDur) e.minDur = 'Minimum cannot be longer than maximum.';
  if (!(c.target > 0 && c.target <= 12)) e.target = 'Enter 0.5 to 12 hours.';
  if (!(c.interval >= 1 && c.interval <= 14)) e.interval = 'Enter 1 to 14 days.';
  if (!(c.minTemp >= -10 && c.minTemp <= 30)) e.minTemp = 'Enter -10 to 30 °C.';
  if (c.dew && !(c.dewHours >= 0.25 && c.dewHours <= 4)) e.dewHours = 'Enter 0.25 to 4 hours.';
  if (c.maxRain < 0) e.maxRain = 'Cannot be negative.';
  if (c.wdOn && !(c.wdEvery >= 1)) e.wdEvery = 'Enter at least 1 minute.';
  if (LOC.lat == null) e.loc = 'Forecasts need a location. Set it in Settings.';
  return e;
}
function rulesTab() {
  const e = validateCfg(CFG), d = dirty();
  const f = (label, path, o = {}) => { const v = path.split('.').reduce((a, k) => a[k], CFG); const eid = `e-${path.replace(/\W/g, '_')}`; return `<label class="field">${label}${o.unit ? ` (${o.unit})` : ''}<input type="${o.type || 'number'}" ${o.step ? `step="${o.step}"` : ''} data-bind="CFG.${path}" data-type="${o.type === 'time' ? 'text' : 'number'}" value="${v}" ${e[path] ? `aria-invalid="true" aria-describedby="${eid}"` : ''}>${o.hint ? `<span class="hint">${o.hint}</span>` : ''}${err(path, e)}</label>`; };
  const chk = (label, path, hint) => `<label class="check"><input type="checkbox" data-bind="CFG.${path}" ${path.split('.').reduce((a, k) => a[k], CFG) ? 'checked' : ''}><span>${label}${hint ? `<small>${hint}</small>` : ''}</span></label>`;
  let h = '';
  if (S.mode === 'classic') h += banner('', 'info-circle', 'Classic mode is active. Windows, the mowing model and protections are saved but used only in Smart mode. The weather watchdog works in both modes.');
  if (e.loc) h += banner('warn', 'geo-alt', `<strong>${e.loc}</strong>`, '<a class="button small" href="#settings">Open location settings</a>');
  h += `<div class="card-title"><h2>Rules &amp; windows</h2>${d ? `<span class="chip warn" id="rules-chip" role="status">${ic('pencil')}Unsaved changes</span>` : '<span class="chip ok" id="rules-chip" role="status">Saved</span>'}</div>`;
  h += `<div class="card"><h3>Mowing windows (local time, ${TZ})</h3><p class="muted small" style="margin:4px 0 12px">Add as many windows per day as you like. The planner fills them in order until the daily target is met. Times are whole hours; a day without a window gets no mowing.</p>${err('windows', e)}<div class="win-list">${WEEK.map(([, , name], di) => {
    const rows = CFG.windows.map((w, i) => [w, i]).filter(([w]) => w.day === di);
    return `<div class="win-day" role="group" aria-label="${name}"><div class="win-name">${name}</div><div class="win-rows">${rows.length ? rows.map(([w, i], n) => `<div class="win-row"><input type="time" step="3600" aria-label="${name} window ${n + 1} start" data-bind="CFG.windows.${i}.s" value="${w.s}" ${e['windows.' + i] ? 'aria-invalid="true"' : ''}><span aria-hidden="true">to</span><input type="time" step="3600" aria-label="${name} window ${n + 1} end" data-bind="CFG.windows.${i}.e" value="${w.e}" ${e['windows.' + i] ? 'aria-invalid="true"' : ''}><button class="button icon" data-act="win-del" data-arg="${i}" aria-label="Remove ${name} window ${n + 1}">${ic('trash')}</button>${err('windows.' + i, e)}</div>`).join('') : '<span class="muted">No mowing</span>'}</div><button class="button" data-act="win-add" data-arg="${di}" aria-label="Add a window on ${name}">${ic('plus-lg')}Add window</button></div>`;
  }).join('')}</div></div>`;
  h += `<div class="card"><h3>Mowing model</h3><label class="field" style="max-width:340px">Plan sessions by<select data-bind="CFG.adaptive" data-type="bool"><option value="false" ${CFG.adaptive ? '' : 'selected'}>Fixed target and interval</option><option value="true" ${CFG.adaptive ? 'selected' : ''}>Adaptive lawn growth</option></select></label><div class="field-grid" style="margin-top:14px">`;
  h += CFG.adaptive ? f('Session length at peak growth', 'sessionHours', { unit: 'h', step: 0.5 }) + f('Days between sessions at peak', 'peakInterval', { unit: 'days' }) + f('Soil water capacity', 'soil', { unit: 'mm' }) : f('Target mowing per day', 'target', { unit: 'h', step: 0.5 }) + f('Mowing interval', 'interval', { unit: 'days' });
  h += f('Shortest session', 'minDur', { unit: 'min' }) + f('Longest session', 'maxDur', { unit: 'min' }) + `</div>${CFG.adaptive ? '' : '<p class="muted small" style="margin-top:8px">Lawn growth is shown for information only while adaptive mowing is off.</p>'}</div>`;
  h += `<div class="card"><h3>Weather limits</h3><p class="muted small" style="margin-bottom:10px">A session must meet every limit. The weather watchdog applies the same rain, wind and temperature limits.</p><div class="field-grid">${f('Minimum temperature', 'minTemp', { unit: '°C' })}${f('Maximum rain', 'maxRain', { unit: 'mm/h', step: 0.1 })}${f('Maximum wind', 'maxWind', { unit: 'm/s', step: 0.5 })}${f('Delay after rain', 'rainDelay', { unit: 'h' })}</div></div>`;
  h += `<div class="card"><h3>Protections</h3>${chk('Daylight-only mowing', 'daylight', 'Also protects hedgehogs and other wildlife at night.')}${chk('Avoid morning dew', 'dew', 'Delays the start until the grass has dried.')}${CFG.dew ? `<div class="subopts">${chk('Estimate from the forecast', 'dewAuto', 'Uses dew point, humidity, temperature and wind. Turn off to always wait the same time.')}<div class="field-grid">${f(CFG.dewAuto ? 'Longest delay after sunrise' : 'Delay after sunrise', 'dewHours', { unit: 'h', step: 0.25 })}</div></div>` : ''}${chk('Heat-stress protection', 'heat', 'No mowing on very hot days.')}${CFG.heat ? `<div class="field-grid">${f('No mowing above', 'heatTemp', { unit: '°C' })}${f('Minimum days between mows', 'heatInterval', { unit: 'days' })}</div>` : ''}</div>`;
  h += `<div class="card"><h3>Weather watchdog</h3>${chk('Park the mower during bad weather', 'wdOn', 'Checks current conditions during sessions.')}${CFG.wdOn ? `<div class="field-grid">${f('Check every', 'wdEvery', { unit: 'min' })}${f('Drying delay after weather clears', 'wdDry', { unit: 'min' })}</div>${S.mode === 'classic' ? '<p class="muted small" style="margin-top:8px">In Classic mode the mower returns to its calendar after the drying delay and restarts only if a calendar window is open.</p>' : ''}` : ''}</div>`;
  h += `<div class="card"><h3>Replanning</h3><div class="field-grid">${f('Replan every', 'replanEvery', { unit: 'h' })}${f('Daily replan time', 'replanAt', { type: 'time' })}</div></div>`;
  const hasErr = Object.keys(e).some(k => k !== 'loc');
  h += `<div class="actions" style="margin-top:18px"><button class="button primary" data-act="rules-save" ${d ? '' : 'disabled'}>${ic('check2')}Save rules</button><button class="button" data-act="rules-save-recalc" ${S.mode === 'smart' ? '' : 'disabled'}>${ic('arrow-repeat')}Save &amp; recalculate</button><button class="button" data-act="rules-discard" ${d ? '' : 'disabled'}>Discard changes</button></div>${hasErr ? `<p class="error small" style="margin-top:8px;color:var(--red)" role="alert">Fix the highlighted fields before saving.</p>` : ''}`;
  return h;
}
function calendarTab() {
  const smart = S.mode === 'smart';
  if (smart) return `<div class="banner">${ic('lock')}<div class="grow"><strong>The planner owns the firmware calendar.</strong> The mower holds only a placeholder task, so calendar editing is disabled. Change when and how long to mow in <button class="text-link" data-act="goto" data-arg="planning/rules">Rules &amp; windows</button>.</div></div><div class="card"><h3>Mower calendar (read-only)</h3><table class="sched-table"><thead><tr><th>Task</th><th>Start</th><th>Duration</th><th>Days</th></tr></thead><tbody><tr><td>Placeholder</td><td>00:00</td><td>1 min</td><td><span class="muted">Not used to start mowing</span></td></tr></tbody></table></div><div class="card"><h3>Your previous calendar</h3>${S.calSaved ? `<p class="small muted">A copy of ${SAVED_CALENDAR.length} tasks (saved 6 Nov 2026 08:12) is kept. You can restore it when you return to Classic mode.</p>` : '<p class="small muted">No copy exists.</p>'}<div style="margin-top:10px"><button class="button" data-act="mode-switch">Return to Classic mode…</button></div></div>`;
  if (!S.calDraft) S.calDraft = S.cal === 'placeholder' ? [] : clone(SAVED_CALENDAR);
  const base = S.cal === 'placeholder' ? [] : SAVED_CALENDAR;
  const d = JSON.stringify(S.calDraft) !== JSON.stringify(base);
  let h = '';
  if (S.cal === 'placeholder') h += banner('warn', 'exclamation-triangle', '<strong>This is not your restored calendar.</strong> The mower only holds the planner\'s placeholder, so it will not start by itself. Add tasks and save to finish.', S.calSaved ? '<button class="button small" data-act="ms-restore">Restore my saved calendar</button>' : '');
  h += `<div class="card"><div class="card-title"><h2>Firmware weekly calendar</h2>${d ? `<span class="chip warn" role="status">${ic('pencil')}Unsaved changes</span>` : ''}</div><table class="sched-table"><thead><tr><th>Start</th><th>Hours</th><th>Days</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>${S.calDraft.map((t, i) => `<tr><td><input type="time" aria-label="Task ${i + 1} start" data-bind="S.calDraft.${i}.start" value="${t.start}"></td><td><input type="number" min="0.5" step="0.5" aria-label="Task ${i + 1} hours" style="width:80px" data-bind="S.calDraft.${i}.hours" data-type="number" value="${t.hours}"></td><td><div class="days" role="group" aria-label="Task ${i + 1} days">${t.days.map((on, k) => `<button class="button small" style="min-width:44px;padding:0;${on ? 'background:var(--green);color:#fff;border-color:var(--green)' : ''}" data-act="cal-day" data-arg="${i}:${k}" aria-pressed="${!!on}" aria-label="${WEEK[k][2]}">${WEEK[k][0][0]}</button>`).join('')}</div></td><td><button class="button small danger" data-act="cal-del" data-arg="${i}" aria-label="Remove task ${i + 1}">${ic('trash')}</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No tasks. The mower will not start by itself.</td></tr>'}</tbody></table><div class="actions" style="margin-top:14px"><button class="button" data-act="cal-add">${ic('plus-lg')}Add task</button><button class="button primary" data-act="cal-save" ${d ? '' : 'disabled'}>${ic('check2')}Save to mower</button><button class="button" data-act="cal-discard" ${d ? '' : 'disabled'}>Discard</button></div></div>`;
  return h;
}
function renderPlanning() {
  const sub = ['week', 'rules', 'calendar'].includes(R.sub) ? R.sub : 'week', smart = S.mode === 'smart';
  let h = `<div class="page-title"><div><h1 id="h-planning" tabindex="-1">A plan that follows the lawn.</h1><p class="subtitle">16 – 22 November 2026 · ${LOC.name ? LOC.name.split(',')[0] : 'No location'} · ${TZ}</p></div>${smart && !S.winter ? `<button class="button primary" data-act="recalc" ${S.plan === 'running' ? 'disabled aria-busy="true"' : ''}>${ic('arrow-repeat')}${S.plan === 'running' ? 'Recalculating…' : 'Recalculate plan'}</button>` : ''}</div>`;
  h += `<div class="card" style="padding:12px 18px;margin-bottom:18px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><span>${ic(smart ? 'stars' : 'calendar-week')} <strong>${smart ? 'Smart mode' : 'Classic mode'}</strong> <span class="muted small">${smart ? 'The planner decides when to mow from weather and lawn growth.' : 'The mower follows its firmware calendar.'}</span></span><button class="button small" data-act="mode-switch">${smart ? 'Switch to Classic…' : 'Enable Smart mode…'}</button></div>`;
  h += TABS('Planning', [['week', 'Upcoming week'], ['rules', 'Rules & windows'], ['calendar', smart ? `${ic('lock')} Calendar` : 'Calendar']], sub);
  h += `<div role="tabpanel" aria-labelledby="tab-${sub}">${sub === 'week' ? weekTab() : sub === 'rules' ? rulesTab() : calendarTab()}</div>`;
  return h;
}
async function doRecalc() {
  S.plan = 'running'; render(); announce('Recalculating plan');
  await wait(1500);
  const o = S.nextRecalc; S.nextRecalc = 'ok'; S.plan = o; S.rulesChanged = false;
  const msg = { ok: 'Plan recalculated: sessions found.', zero: 'Plan recalculated: no suitable sessions in the next 7 days.', failed: 'Recalculation failed. The previous plan is kept and marked outdated.', invalid: 'Planning setup is invalid. Check the rules and location.' }[o];
  logEvent('Planner', o === 'failed' ? 'x-octagon' : 'arrow-repeat', msg);
  render(); announce(msg); toast(msg, o === 'failed' || o === 'invalid');
}
Object.assign(ACTIONS, {
  goto: v => { location.hash = v; },
  'sel-day': v => { S.selDay = Number(v); if (R.arg != null) location.hash = `planning/week/${v}`; },
  recalc: () => {
    if (S.plan === 'running') return;
    if (dirty()) { openDlg(`<h2 id="dlg-title">You have unsaved rule changes</h2><p>Recalculation uses the <strong>saved</strong> rules. Your edits are not applied unless you save them.</p><div class="actions"><button class="button" data-act="dlg-close">Cancel</button><button class="button" data-act="rc-saved">Recalculate with saved rules</button><button class="button primary" data-act="rc-save">Save &amp; recalculate</button></div>`); return; }
    doRecalc();
  },
  'rc-saved': () => { $('#dlg').close(); doRecalc(); },
  'rc-save': () => { $('#dlg').close(); ACTIONS['rules-save-recalc'](); },
  'rules-save': () => { const e = validateCfg(CFG); if (Object.keys(e).some(k => k !== 'loc')) { toast('Some rules are invalid. Fix them first.', true); return false; } cfgSaved = clone(CFG); S.adaptive = CFG.adaptive; S.rulesChanged = true; toast('Rules saved. Recalculate to apply them to the plan.'); announce('Rules saved'); return true; },
  'rules-save-recalc': () => { if (ACTIONS['rules-save']()) doRecalc(); },
  'rules-discard': () => { CFG = clone(cfgSaved); announce('Changes discarded'); },
  'win-add': v => {
    const day = Number(v), mine = CFG.windows.filter(w => w.day === day), hh = n => String(n).padStart(2, '0') + ':00';
    const s = mine.length ? Math.max(...mine.map(w => Number(w.e.slice(0, 2)))) : 9;
    CFG.windows.push({ day, s: hh(s), e: hh(Math.min(s + (mine.length ? 2 : 7), 23)) });
    announce(`Window added on ${WEEK[day][2]}`);
  },
  'win-del': v => { const [w] = CFG.windows.splice(Number(v), 1); announce(`Window removed on ${WEEK[w.day][2]}`); },
  'cal-day': v => { const [i, k] = v.split(':').map(Number); S.calDraft[i].days[k] = S.calDraft[i].days[k] ? 0 : 1; },
  'cal-del': v => { S.calDraft.splice(Number(v), 1); },
  'cal-add': () => { S.calDraft.push({ id: Date.now(), start: '10:00', hours: 2, days: [1, 0, 0, 0, 0, 0, 0] }); },
  'cal-discard': () => { S.calDraft = null; },
  'cal-save': async () => { if (S.calDraft.some(t => !t.days.some(Boolean) || !(t.hours > 0))) { toast('Every task needs at least one day and a positive duration.', true); return; } toast('Writing calendar…'); await wait(900); S.cal = 'user'; S.calSaved = true; toast('Calendar saved and verified on the mower.'); logEvent('Command', 'terminal', 'Firmware calendar saved'); render(); announce('Calendar saved and verified on the mower'); },
});

// ---------- activity ----------
const SEGC = { mow: '#16754f', charge: '#2d6390', search: '#c89a1a' };
const SEGL = { mow: 'Mowing', charge: 'Charging', search: 'Searching' };
function liveSession() {
  if (!S.session || !['mowing', 'charging', 'paused', 'returning'].includes(S.activity) || S.firstRun) return null;
  const x = S.session, seg = [['mow', x.mow]]; if (x.chg) seg.push(['charge', x.chg]);
  return { id: 'live', date: `${WEEK[S.today][0]} ${WEEK[S.today][1]} Nov`, start: x.start, kind: 'live', seg: x.mow || x.chg ? seg : [], end_reason: 'Session in progress.', gps: 22 };
}
const sessionList = () => [liveSession(), ...SESSIONS].filter(Boolean);
const tot = (s, k) => (s.seg ? s.seg.filter(x => x[0] === k).reduce((a, x) => a + x[1], 0) : null);
const elapsed = s => (s.seg ? s.seg.reduce((a, x) => a + x[1], 0) : null);
const KIND = { live: ['blue', 'Live'], complete: ['', 'Complete'], interrupted: ['amber', 'Interrupted'], incomplete: ['amber', 'Incomplete'], imported: ['gray', 'Imported'] };
function curve(s) {
  if (!s.seg || !s.seg.length) return '<p class="muted small">Not available for this record.</p>';
  const total = elapsed(s); let b = 100, t = 0; const pts = [`0,${120 - b * 1.2}`];
  s.seg.forEach(([k, m]) => { for (let i = 0; i < m; i++) { b = Math.max(0, Math.min(100, b + SEG_RATE[k])); t++; if (i % 5 === 4 || i === m - 1) pts.push(`${(t / total * 600).toFixed(1)},${(120 - b * 1.2).toFixed(1)}`); } });
  return `<svg class="curve" viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label="Battery curve from 100% to ${Math.round(b)}% over ${dur(total)}"><polyline fill="none" stroke="#16754f" stroke-width="2" points="${pts.join(' ')}"/></svg>`;
}
function sessionDetail(id) {
  const s = sessionList().find(x => x.id === id);
  if (!s) return `<div class="empty">${ic('question-circle')}<h2>This record is not available</h2><p>It may have been deleted or is not in the history anymore.</p><a class="button" href="#activity/sessions">Back to sessions</a></div>`;
  const k = KIND[s.kind], el = elapsed(s), m = s.seg ? tot(s, 'mow') : s.mowOnly;
  const parts = ['mow', 'charge', 'search'].filter(x => s.seg && tot(s, x));
  let h = `<a class="text-link" href="#activity/sessions">← All sessions</a><div class="page-title" style="margin-top:10px"><div><h2 style="font:24px Georgia,serif">${s.date}${s.start !== '—' ? ', ' + s.start : ''}</h2><p class="subtitle"><span class="tag ${k[0]}">${k[1]}</span></p></div></div>`;
  h += `<div class="metrics" style="margin-top:0"><div class="metric"><h3>Mowing</h3><strong>${dur(m)}</strong></div><div class="metric"><h3>Charging</h3><strong>${s.seg ? dur(tot(s, 'charge')) : '—'}</strong>${s.seg ? '' : '<small>Not recorded</small>'}</div><div class="metric"><h3>Searching</h3><strong>${s.seg ? dur(tot(s, 'search')) : '—'}</strong>${s.seg ? '' : '<small>Not recorded</small>'}</div><div class="metric"><h3>Elapsed, total</h3><strong>${s.seg ? dur(el) : '—'}</strong>${s.seg ? '' : '<small>Not recorded</small>'}</div></div>`;
  if (s.seg && s.seg.length) h += `<div class="card"><h3>Timeline</h3><div class="timeline" role="img" aria-label="${parts.map(x => SEGL[x] + ' ' + dur(tot(s, x))).join(', ')}">${s.seg.map(([kk, mm]) => `<span style="width:${mm / el * 100}%;background:${SEGC[kk]}" title="${SEGL[kk]} ${dur(mm)}"></span>`).join('')}</div><div class="legend">${parts.map(x => `<span><i style="background:${SEGC[x]}"></i>${SEGL[x]} ${dur(tot(s, x))}</span>`).join('')}</div><p class="small muted" style="margin-top:8px">${s.kind === 'incomplete' ? 'End time was not observed; elapsed time is estimated up to the last sample.' : `Elapsed ${dur(el)} = ${parts.map(x => dur(tot(s, x)) + ' ' + SEGL[x].toLowerCase()).join(' + ')}.`}</p></div><div class="card"><h3>Battery</h3>${curve(s)}</div>`;
  h += `<div class="card"><h3>How it ended</h3><p>${s.end_reason}</p></div><div class="card"><h3>Location and coverage</h3>${s.gps == null ? '<p class="muted small">No GPS track was recorded for this session.</p>' : `<div class="map-ph">Map placeholder · ${s.gps}% of the garden covered${s.kind === 'live' ? ' so far' : ''}</div><label class="field" style="max-width:240px;margin-top:10px">Coverage cell size<select><option>1 m</option><option>2 m</option><option>5 m</option></select></label>`}</div>`;
  if (s.id !== 'live') h += `<div style="margin-top:16px"><button class="button danger" data-act="del-session" data-arg="${s.id}">${ic('trash')}Delete this session</button></div>`;
  return h;
}
function sessionsTab() {
  if (R.arg) return sessionDetail(R.arg);
  const l = sessionList();
  let h = S.conn !== 'connected' ? banner('warn', 'clock-history', 'Not connected: the live session may be incomplete. Stored sessions are unaffected.') : '';
  h += `<div class="list">${l.map(s => `<button class="row" data-act="goto" data-arg="activity/sessions/${s.id}"><div class="day-stamp"><small>${s.date.split(' ')[0].toUpperCase()}</small><strong>${s.date.split(' ')[1]}</strong></div><div class="row-main"><strong>${s.start !== '—' ? s.start : 'Start time unknown'} · ${dur(s.seg ? tot(s, 'mow') : s.mowOnly)} mowing</strong><small>${s.seg ? 'Elapsed ' + dur(elapsed(s)) : 'Elapsed time not recorded'}</small></div><span class="tag ${KIND[s.kind][0]}">${KIND[s.kind][1]}</span></button>`).join('') || '<div class="row muted">No sessions yet.</div>'}</div>`;
  return h;
}
function messagesTab() {
  let h = '';
  h += `<div class="card"><h3>Active errors</h3>${S.error ? `<div class="banner bad" style="margin:0">${ic('exclamation-octagon')}<div class="grow"><strong>${S.error.name}</strong> since ${S.error.since}. The mower has stopped. Free it and confirm on the mower; this entry clears once the mower reports OK.</div></div>` : `<p class="small muted">${S.conn === 'connected' ? 'No active errors.' : 'Unknown: the mower is not connected.'}</p>`}</div>`;
  h += `<div class="card"><h3>Message history</h3><p class="small muted" style="margin-bottom:10px">Past messages from the mower's log. They are not current faults.${S.conn !== 'connected' ? ' Last read 13:25.' : ''}</p><div class="list">${MESSAGES.map(m => `<div class="row"><div class="row-main"><strong>${m.name}</strong><small>${m.when} · ${m.sev}</small></div><span class="tag gray">${m.resolved}</span></div>`).join('')}</div></div>`;
  return h;
}
function eventsTab() {
  return `<p class="small muted" style="margin-bottom:10px">Events recorded by this app since 9 Nov 2026. Older events are not available. Command details are stored as plain text.</p><div class="list">${S.log.map(e => `<div class="row"><span class="muted small" style="min-width:110px">${e.when}</span>${ic(e.icon)}<div class="row-main"><strong style="font-weight:500">${e.text}</strong></div><span class="tag gray">${e.src}</span></div>`).join('') || '<div class="row muted">No events yet.</div>'}</div>`;
}
function estimate(min) {
  const cyc = 115, full = Math.floor(min / cyc), rem = min - full * cyc;
  return { mow: full * 75 + Math.min(rem, 75), chg: full * 40 + Math.max(0, rem - 75), stops: full + (rem > 75 ? 1 : 0) };
}
function perfTab() {
  const lk = S.conn !== 'connected', est = estimate(Number(S.estMin ?? 180)), okEst = Number(S.estMin ?? 180) >= 15 && Number(S.estMin ?? 180) <= 1440;
  const stat = (l, v) => `<div class="metric"><h3>${l}</h3><strong>${v}</strong></div>`;
  let h = lk ? banner('warn', 'clock-history', 'Not connected: lifetime counters are last known values.') : '';
  h += `<div class="card"><h3>Lifetime counters</h3><div class="metrics" style="border:0;margin:12px 0 0;padding:0">${stat('Running', '412 h')}${stat('Cutting', '301 h')}${stat('Charging', '188 h')}${stat('Searching', '41 h')}</div><div class="metrics" style="border:0;margin:12px 0 0;padding:0">${stat('Collisions', '1 204')}${stat('Charge cycles', '296')}${stat('Blade usage', S.bladeHours + ' h')}${stat('Cutting ratio', '73%')}</div><p class="small muted" style="margin-top:10px">Efficiency: 10% searching · 38 min average charge per cycle · 2.9 collisions per running hour.</p></div>`;
  h += `<div class="card"><h3>Runtime estimator</h3><p class="small muted" style="margin:4px 0 12px">${S.samples > 0 ? `Learned from ${S.samples.toLocaleString('en')} battery samples (about 24.7 h).` : 'Fallback: not enough samples, so lifetime statistics are used. The estimate is less precise.'}</p><div class="field-grid" style="align-items:start"><label class="field">Session duration (minutes)<input type="number" data-bind="S.estMin" data-type="number" value="${S.estMin ?? 180}" ${okEst ? '' : 'aria-invalid="true" aria-describedby="est-err"'}>${okEst ? '<span class="hint">15 to 1440</span>' : '<span class="error" id="est-err">Enter 15 to 1440 minutes.</span>'}</label><dl class="kv" style="align-self:end">${okEst ? `<dt>Cutting</dt><dd>${dur(est.mow)}</dd><dt>Charging</dt><dd>${dur(est.chg)}</dd><dt>Charge stops</dt><dd>${est.stops}</dd>` : '<dt>Estimate</dt><dd>—</dd>'}</dl></div></div>`;
  h += `<div class="card"><h3>Resets</h3><div class="stack"><div><button class="button danger" data-act="reset-blade" ${lk ? 'disabled' : ''}>Reset blade usage…</button><p class="small muted" style="margin-top:4px">Sets the blade counter on the mower to 0 h. Sessions, counters and estimator samples are not touched.${lk ? ' Needs a connection.' : ''}</p></div><div><button class="button danger" data-act="reset-samples" ${S.samples ? '' : 'disabled'}>Reset runtime samples…</button><p class="small muted" style="margin-top:4px">Deletes ${S.samples.toLocaleString('en')} stored battery samples used by the estimator. Blade usage and session history are not touched.</p></div></div></div>`;
  return h;
}
function renderActivity() {
  const sub = ['sessions', 'messages', 'events', 'performance'].includes(R.sub) ? R.sub : 'sessions';
  let h = `<div class="page-title"><div><h1 id="h-activity" tabindex="-1">The garden journal</h1><p class="subtitle">Sessions, mower messages, events and performance</p></div></div>`;
  h += TABS('Activity', [['sessions', 'Sessions'], ['messages', `Messages${S.error ? ' (1 active)' : ''}`], ['events', 'Events'], ['performance', 'Performance']], sub);
  h += `<div role="tabpanel" aria-labelledby="tab-${sub}">${{ sessions: sessionsTab, messages: messagesTab, events: eventsTab, performance: perfTab }[sub]()}</div>`;
  return h;
}
Object.assign(ACTIONS, {
  'del-session': id => confirmDlg({ title: 'Delete this session?', body: '<p>This removes the session with its GPS fixes and events. Other sessions, messages and statistics are kept.</p>', confirm: 'Delete session', danger: true, run: () => { const i = SESSIONS.findIndex(x => x.id === id); if (i >= 0) SESSIONS.splice(i, 1); location.hash = 'activity/sessions'; toast('Session deleted'); } }),
  'reset-blade': () => confirmDlg({ title: 'Reset blade usage?', body: '<p>The blade counter on the mower is set to 0 h. This cannot be undone. Session history, lifetime counters and runtime samples are not changed.</p>', confirm: 'Reset blade usage', danger: true, run: () => { S.bladeHours = 0; logEvent('Command', 'terminal', 'Blade usage reset'); toast('Blade usage reset'); } }),
  'reset-samples': () => confirmDlg({ title: 'Reset runtime samples?', body: `<p>${S.samples.toLocaleString('en')} stored battery samples are deleted and the estimator starts learning again. Until then it uses lifetime statistics. Blade usage and session history are not changed.</p>`, confirm: 'Delete samples', danger: true, run: () => { S.samples = 0; toast('Runtime samples deleted'); } }),
});

// ---------- settings ----------
const KNOWN = { berlin: { name: 'Berlin, Germany', lat: 52.52, lon: 13.405 }, munich: { name: 'Munich, Germany', lat: 48.137, lon: 11.575 }, hamburg: { name: 'Hamburg, Germany', lat: 53.55, lon: 9.994 } };
function connectionCard() {
  const c = CONNUI, bz = ['scanning', 'connecting', 'reconnecting'].includes(S.conn);
  if (S.conn === 'connected') return `<div class="card"><div class="card-title"><h2>Mower connection</h2><span class="chip ok">${ic('bluetooth')}Connected</span></div><dl class="kv"><dt>Mower</dt><dd>Demo Mower · Automower 450X</dd><dt>Address</dt><dd>AA:BB:CC:11:22:33</dd><dt>Channel</dt><dd>${c.channel}</dd></dl><label class="check" style="margin-top:10px"><input type="checkbox" data-bind="S.autoRec" ${S.autoRec !== false ? 'checked' : ''}><span>Reconnect automatically<small>${S.autoRec !== false ? 'Enabled: the app reconnects after a lost connection.' : 'Disabled: you must reconnect manually.'}</small></span></label><div class="actions" style="margin-top:10px"><button class="button" data-act="sync-clock">${ic('clock')}Synchronise clock</button><button class="button danger" data-act="disconnect">Disconnect…</button></div></div>`;
  const states = { scanning: 'Scanning for mowers…', connecting: 'Connecting and pairing…', reconnecting: 'Reconnecting…' };
  let h = `<div class="card"><div class="card-title"><h2>Mower connection</h2><span class="chip ${S.conn === 'disconnected' ? (S.firstRun ? '' : 'bad') : 'warn'}">${S.conn === 'disconnected' ? (S.firstRun ? 'Not set up' : 'Not connected') : states[S.conn].replace('…', '')}</span></div>`;
  if (c.msg) h += banner(c.msg.bad ? 'bad' : 'ok', c.msg.bad ? 'x-octagon' : 'check-circle', c.msg.t);
  if (bz) h += `<p role="status" class="muted">${states[S.conn]}</p><div class="skeleton"></div>`;
  h += `<h3>1. Find your mower</h3><div class="actions"><label class="field" style="width:170px"><span class="sr-only">Scan time</span><select data-bind="CONNUI.timeout" data-type="number" ${bz ? 'disabled' : ''}><option value="5">Scan for 5 s</option><option value="10" ${c.timeout === 10 ? 'selected' : ''}>Scan for 10 s</option><option value="20">Scan for 20 s</option></select></label><button class="button" data-act="scan" ${bz ? 'disabled' : ''}>${ic('search')}Scan</button></div>`;
  if (c.scan === 'done') h += `<div class="list" style="margin-top:10px">${c.found.map(d => `<button class="row" data-act="pick" data-arg="${d.addr}" aria-pressed="${c.sel === d.addr}"><div class="row-main"><strong>${d.name}</strong><small>${d.addr} · signal ${d.rssi} dBm</small></div>${d.hq ? `<span class="tag">Husqvarna</span>` : '<span class="tag gray">Other device</span>'}</button>`).join('')}</div>`;
  const badAddr = c.addr && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(c.addr);
  h += `<h3 style="margin-top:18px">2. Pairing details</h3><div class="field-grid"><label class="field">Bluetooth address<input data-bind="CONNUI.addr" value="${c.addr}" placeholder="AA:BB:CC:11:22:33" autocomplete="off" ${badAddr ? 'aria-invalid="true" aria-describedby="addr-err"' : ''}>${badAddr ? '<span class="error" id="addr-err">Use the format AA:BB:CC:11:22:33.</span>' : ''}</label><label class="field">Channel ID<input type="number" data-bind="CONNUI.channel" data-type="number" value="${c.channel}"></label><label class="field">PIN (optional)<input type="password" autocomplete="off" inputmode="numeric" data-bind="CONNUI.pin"><span class="hint">Sent once to pair. It is never shown or logged.</span></label></div><div class="actions" style="margin-top:14px"><button class="button primary" data-act="connect" ${bz || !c.addr || badAddr ? 'disabled' : ''}>${ic('bluetooth')}Connect</button></div>`;
  h += `<label class="check" style="margin-top:12px"><input type="checkbox" data-bind="S.autoRec" ${S.autoRec !== false && !S.winter ? 'checked' : ''} ${S.winter ? 'disabled' : ''}><span>Reconnect automatically${S.winter ? '<small>Paused by winter mode.</small>' : ''}</span></label></div>`;
  return h;
}
function locationCard() {
  const d = LOC.draft;
  const badLat = d.lat !== '' && !(Number(d.lat) >= -90 && Number(d.lat) <= 90), badLon = d.lon !== '' && !(Number(d.lon) >= -180 && Number(d.lon) <= 180);
  const half = (d.lat !== '') !== (d.lon !== '');
  return `<div class="card"><h2>Garden location</h2><p class="muted small" style="margin:4px 0 12px">Used for weather forecasts and daylight times.</p>${LOC.lat == null ? banner('warn', 'geo-alt', 'No location saved yet. Planning cannot run without one.') : `<dl class="kv" style="margin-bottom:12px"><dt>Saved</dt><dd>${LOC.name}</dd><dt>Coordinates</dt><dd>${LOC.lat}, ${LOC.lon}</dd><dt>Timezone</dt><dd>${LOC.tz}</dd></dl>`}${LOC.msg ? banner(LOC.msg.bad ? 'bad' : 'ok', LOC.msg.bad ? 'x-octagon' : 'check-circle', LOC.msg.t) : ''}<div class="field-grid" style="align-items:start"><label class="field">City<input data-bind="LOC.draft.city" value="${d.city}" placeholder="Try Berlin or Munich"></label><div style="align-self:end"><button class="button" data-act="lookup" ${d.city ? '' : 'disabled'}>${ic('search')}Look up city</button></div></div>${d.res ? `<div class="banner ok" style="margin-top:12px">${ic('geo-alt')}<div class="grow"><strong>Found: ${d.res.name}</strong> ${d.res.lat}, ${d.res.lon}<div class="actions"><button class="button small primary" data-act="use-loc">Use this location</button></div></div></div>` : ''}<h3 style="margin-top:18px">Or enter coordinates</h3><div class="field-grid"><label class="field">Latitude<input type="number" step="0.0001" data-bind="LOC.draft.lat" data-type="number" value="${d.lat}" ${badLat || half ? 'aria-invalid="true"' : ''}>${badLat ? '<span class="error">Latitude must be between -90 and 90.</span>' : ''}</label><label class="field">Longitude<input type="number" step="0.0001" data-bind="LOC.draft.lon" data-type="number" value="${d.lon}" ${badLon || half ? 'aria-invalid="true"' : ''}>${badLon ? '<span class="error">Longitude must be between -180 and 180.</span>' : ''}</label></div>${half ? '<p class="error small" style="margin-top:6px;color:var(--red)">Enter both latitude and longitude.</p>' : ''}<div style="margin-top:12px"><button class="button" data-act="save-coords" ${d.lat === '' || d.lon === '' || badLat || badLon ? 'disabled' : ''}>Save coordinates</button></div></div>`;
}
function seasonCard() {
  return `<div class="card"><h2>Seasonal care</h2><div class="field-grid" style="margin:12px 0"><label class="field">Winter usually starts<input type="date" value="2026-11-01"></label><label class="field">Winter usually ends<input type="date" value="2027-03-15"></label></div>${S.winter ? `<p class="small"><strong>Winter mode is active</strong> since ${S.winterSince}. Planning, watchdog and auto-reconnect are paused.</p><div style="margin-top:10px"><button class="button primary" data-act="winter-leave">Leave winter mode…</button></div>` : `<p class="small muted">Winter mode pauses planning, the weather watchdog and auto-reconnect. It does not stop or store the mower, and the firmware calendar stays unchanged.</p><div style="margin-top:10px"><button class="button" data-act="winter-enter">Enter winter mode…</button></div>`}<label class="check" style="margin-top:12px"><input type="checkbox" data-bind="S.snow" ${S.snow ? 'checked' : ''}><span>Show snow animation in winter mode<small>Saved in this browser only. Off automatically if your system prefers reduced motion.</small></span></label></div>`;
}
function renderSettings() {
  return `<div class="page-title"><div><h1 id="h-settings" tabindex="-1">Garden settings</h1><p class="subtitle">Connection, location and seasonal preferences</p></div></div><div class="stack">${connectionCard()}${locationCard()}${seasonCard()}</div>`;
}
Object.assign(ACTIONS, {
  scan: async () => { const prev = S.conn; S.conn = 'scanning'; CONNUI.msg = null; render(); await wait(1800); S.conn = prev; CONNUI.scan = 'done'; CONNUI.found = [{ name: 'Automower 450X', addr: 'AA:BB:CC:11:22:33', rssi: -58, hq: true }, { name: 'Fitness band', addr: '12:34:56:78:9A:BC', rssi: -81, hq: false }]; render(); announce('Scan finished: 2 devices found'); },
  pick: a => { CONNUI.sel = a; CONNUI.addr = a; },
  connect: async () => {
    const prev = S.conn; S.conn = 'connecting'; CONNUI.msg = null; render(); await wait(1600);
    if (S.nextConnect === 'fail') { S.nextConnect = 'ok'; S.conn = prev; CONNUI.pin = ''; CONNUI.msg = { bad: true, t: 'Could not connect: the mower did not accept the pairing. Your address and channel are kept; re-enter the PIN and retry.' }; render(); announce('Connection failed'); return; }
    Object.assign(S, { conn: 'connected', fresh: 'live', lastSeen: null, firstRun: false, battery: 100 }); if (S.plan === 'invalid' && LOC.lat != null && !S.winter) S.plan = 'invalid';
    CONNUI.pin = ''; CONNUI.msg = null; logEvent('Connection', 'bluetooth', 'Connected to Demo Mower'); render(); announce('Connected to Demo Mower');
  },
  disconnect: () => confirmDlg({ title: 'Disconnect the mower?', body: '<p>The app stops reading status and cannot send commands. Auto-reconnect is turned off so it does not reconnect on its own. The mower keeps following its own settings.</p>', confirm: 'Disconnect', danger: true, run: () => { S.conn = 'disconnected'; S.fresh = 'stale'; S.lastSeen = S.now; S.autoRec = false; logEvent('Connection', 'bluetooth', 'Disconnected by you'); toast('Disconnected'); } }),
  lookup: async () => { const q = LOC.draft.city.trim().toLowerCase(); LOC.msg = null; LOC.draft.res = null; render(); await wait(700); const r = KNOWN[q.split(',')[0]]; if (r) LOC.draft.res = r; else LOC.msg = { bad: true, t: `No match for “${LOC.draft.city}”. Your saved location is unchanged: ${LOC.name || 'none'}.` }; render(); announce(r ? `Found ${r.name}` : 'No match found'); },
  'use-loc': () => { const r = LOC.draft.res; Object.assign(LOC, { name: r.name, lat: r.lat, lon: r.lon, tz: 'Europe/Berlin (CET, UTC+1)' }); LOC.draft = { city: '', lat: '', lon: '' }; LOC.msg = { t: `Saved: ${r.name}. Recalculate the plan to use it.` }; announce('Location saved'); },
  'save-coords': () => { const d = LOC.draft; Object.assign(LOC, { name: `${d.lat}, ${d.lon}`, lat: d.lat, lon: d.lon, tz: 'Europe/Berlin (CET, UTC+1)' }); LOC.draft = { city: '', lat: '', lon: '' }; LOC.msg = { t: 'Coordinates saved. Recalculate the plan to use them.' }; announce('Coordinates saved'); },
});
