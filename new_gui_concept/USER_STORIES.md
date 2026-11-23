# GUI Implementation User Stories

## Purpose

Implement the task-oriented GUI illustrated in [gui-concept.html](gui-concept.html), replacing the current feature-tab organization without losing existing mower functionality.

The first concept draft is preserved unchanged as [gui-concept-v1.html](gui-concept-v1.html). The current concept adds a demo-only state switcher (collapsed panel, bottom of the page) that exercises the scenarios below: winter, disconnected, stale data, paused, errors, invalid or missing setup, zero-session plans, failed recalculation, and failed mode transitions. Backend work the stories depend on is specified in [BACKEND_CONTRACTS.md](BACKEND_CONTRACTS.md).

The concept uses illustrative data and local-only interactions. Its values, timings, confirmations, and simulated transitions are not production requirements. The implemented GUI must reflect actual server state and the existing Smart and Classic control semantics documented in [README.md](README.md).

## Priorities

- **P0 - Release gate:** Prevent misleading state, unsafe mode transitions, and accidental real commands in demo mode.
- **P1 - Core experience:** Required for the initial redesigned GUI.
- **P2 - Follow-up:** Useful refinements after the core experience works.

## Navigation And Feature Ownership

| New section | Responsibilities | Existing features retained |
| --- | --- | --- |
| Overview | Current state, reason, next action, essential commands, conditions | Status, session context, battery, active errors, watchdog summary |
| Control | Manual operation and mower adjustments | Mow, pause, park, resume, other supported commands |
| Planning | Upcoming plan, decision reasons, rules and windows | Planner, forecast, growth model, watchdog configuration, Classic weekly schedule |
| Activity | Past sessions, commands, messages, performance | History, message log, statistics, runtime estimator, location and coverage |
| Settings | Connection, garden location, seasonal preferences | Scan, pair, disconnect, auto-reconnect, location configuration, winter mode |

Planning rules belong in Planning, not in general Settings. The location used for forecasts belongs in Settings; mower GPS tracks and coverage belong with session details in Activity. Overview may link to either without duplicating their editors.

## Stories

### US-01 - Find The Right Task

**Priority:** P1

As a mower owner, I want five clearly named sections so that I can find everyday tasks without understanding the application's internal modules.

**Acceptance criteria**
- The main sections are Overview, Control, Planning, Activity, and Settings; Overview is the default entry point.
- Desktop uses persistent side navigation; phone layouts use bottom navigation with the same labels and destinations.
- The current section is visibly and programmatically identified. Direct links, reload, and browser Back/Forward retain the selected destination.
- Existing features remain reachable through the ownership map above. A disconnected first visit offers a direct route to connection setup rather than an unexplained empty dashboard.

### US-02 - Understand The Mower At A Glance

**Priority:** P1

As a mower owner, I want current state, its reason, and the next expected action together so that I can decide whether intervention is needed.

**Acceptance criteria**
- Overview shows mower identity, connection, control mode, activity, battery, active errors, and data freshness.
- During a session it shows the current session's end time and remaining time, including charging context when available, rather than substituting the next session.
- When idle it shows the next planned session in Smart mode or firmware start in Classic mode. When none exists it explains the known reason without repeatedly suggesting a planner run that already succeeded.
- Mowing duration and elapsed session duration, including charging, are labeled separately. Unavailable measurements are not presented as zero.

### US-03 - See Truthful, Consistent State

**Priority:** P0

As a mower owner, I want status and command feedback to match the mower and planner so that I do not act on misleading information.

**Acceptance criteria**
- Overview, Control, Planning, and Activity use consistent names for mower activity and planner inhibition.
- A paused mower in the garden is described as paused or stopped in place, never as parked at home. A paused planner is distinguishable from a paused mower.
- Sending, acceptance, and observed completion of a command are distinct states. A successful request alone does not prove that the mower has reached its destination.
- Disconnection, stale data, and request failures remain visible. Last-known values are labeled and no longer described as live.

### US-04 - Start A Manual Mowing Session

**Priority:** P1

As a mower owner, I want to start mowing for a chosen duration so that I can handle an immediate need without editing the automatic plan.

**Acceptance criteria**
- Overview offers a quick-start path with a visible duration; Control allows choosing a valid duration before sending the command.
- Duration validation uses supported backend limits and units. Invalid values do not issue commands, and repeated clicks while pending do not submit duplicates.
- Smart mode explains that this is a manual session and what happens afterward; Classic mode explains the firmware override behavior.
- After acceptance, the GUI refreshes authoritative session and mower state. Rejection preserves the user's selection and displays an actionable error.

### US-05 - Pause, Park, Skip, And Resume Deliberately

**Priority:** P0

As a mower owner, I want the different stop actions to have explicit consequences so that I can stop mowing without accidentally permitting an unwanted restart.

**Acceptance criteria**
- Control distinguishes stopping in place, returning home until resumed, timed parking, and skipping the current session; labels adapt to Smart or Classic semantics.
- Before executing an action, its visible description states whether it inhibits future planner sessions and whether restarting is automatic or manual.
- Resume clears the appropriate inhibit or override using the existing backend behavior; the UI explains whether the mower resumes a current session or waits for the next one.
- Skipping affects only the active session in Smart mode. With no active session, the action is unavailable with a reason or produces an explicit no-op result.

### US-06 - Switch Control Modes Without Losing The Calendar

**Priority:** P0

As a mower owner, I want to understand and control schedule changes when switching modes so that returning to Classic mode does not silently leave a placeholder calendar.

**Acceptance criteria**
- Before Smart mode takes ownership, the transition explains changes to the firmware schedule and preserves a recoverable copy of the existing calendar.
- While Smart mode owns the calendar, every firmware editing action, including row edits and deletion, is disabled; the GUI links to planner rules instead.
- Returning to Classic mode offers an explicit choice to restore the saved calendar or review and save a replacement. A placeholder is never silently presented as the restored calendar.
- The resulting mode and calendar are verified against the server. Partial failures show which step failed and retain recovery options; the UI does not report an unverified transition as complete.

### US-07 - Understand The Upcoming Plan

**Priority:** P1

As a mower owner, I want to see upcoming mowing sessions before configuration so that I can quickly understand the coming week.

**Acceptance criteria**
- Planning opens on the upcoming seven days, using a desktop calendar and a phone agenda without page-level horizontal scrolling.
- Each day shows scheduled sessions or a specific reason for no session, such as temperature, rain, insufficient growth, or no available window.
- A summary gives upcoming session count, expected cutting time, next session, last calculation time, and timezone. Completed sessions are not counted as upcoming.
- Selecting a session or decision exposes relevant timings, forecast values, and configured thresholds. Historical or stale plans are labeled rather than represented as a fresh upcoming plan.

### US-08 - Configure Rules And Recalculate

**Priority:** P1

As a mower owner, I want a separate rules editor so that I can change mowing constraints without cluttering routine monitoring.

**Acceptance criteria**
- Planning provides separate Upcoming Week and Rules & Windows views. The rules editor retains existing windows, durations, intervals, adaptive settings, weather limits, protections, watchdog settings, and replan timing.
- Inputs have units and supported validation, including weekday windows, coordinate dependencies, and minimum/maximum relationships. Backend validation errors appear beside the affected inputs when possible.
- Each weekday can have zero, one, or several mowing windows, as in the current GUI and the planner's `available_windows` list. Windows on one day must end after they start and must not overlap; times are whole hours; a day without a window gets no mowing and is explained as such in the plan.
- Unsaved changes are visibly distinguished. Recalculation explicitly uses saved configuration or offers Save & Recalculate; changes cannot be silently ignored.
- Recalculation distinguishes running, successful with sessions, successful with no suitable sessions, invalid setup, and failed. Missing windows are not displayed with success styling. Results and affected summaries refresh together.

### US-09 - Understand Weather And Growth Decisions

**Priority:** P1

As a mower owner, I want weather and lawn-growth information tied to planning decisions so that I can understand why the mower runs or rests.

**Acceptance criteria**
- Overview summarizes current conditions, configured location, applicable restrictions, and weather freshness; Planning retains access to the detailed hourly forecast.
- Watchdog status distinguishes disabled, monitoring, weather hold, drying delay, and unavailable data, including the last check and next action when known.
- The watchdog works in both modes with the same settings. In Classic mode it parks the mower in bad weather and, after the drying delay, returns it to the firmware calendar; Classic never shows a make-up session.
- Growth information includes mowing owed and the session threshold. When adaptive mowing is off, the model is explicitly display-only and does not imply it controls scheduling.
- The daily target follows one rule everywhere: with adaptive mowing off, the target is the user's configured value and growth data is information only; with adaptive mowing on, growth-based data replaces the target ("mowing owed" versus the session threshold). The two are never shown as competing targets (see C-10 in [BACKEND_CONTRACTS.md](BACKEND_CONTRACTS.md)).
- Protection indicators reflect server configuration and actual applicability. For example, daylight restrictions are not claimed active when disabled.

### US-10 - Connect And Configure A Mower

**Priority:** P1

As a mower owner, I want connection setup in Settings so that I can pair and maintain my mower without seeing setup forms during every visit.

**Acceptance criteria**
- Settings supports scanning with timeout, selecting a discovered device, manual BLE address entry, pairing parameters, optional PIN, disconnect, and auto-reconnect.
- Scanning, connecting, connected, reconnecting, and failure states are distinct and reflected in the global connection indicator.
- Failed setup keeps non-sensitive input and offers a retry. PINs are not exposed in logs, notifications, or activity details.
- Location supports city lookup and direct coordinates, with visible resolved location and timezone; unsuccessful lookup does not overwrite the saved location.

### US-11 - Review Sessions And Troubleshoot

**Priority:** P1

As a mower owner, I want a unified Activity area so that I can trace commands, sessions, and errors without searching unrelated tabs.

**Acceptance criteria**
- Activity provides clearly labeled access to sessions, mower messages, and available command/planner events, with source and timestamp. Unsupported event history is not fabricated.
- Session details retain start/end times, mowing/charging/searching durations, battery curve, termination reason, and available GPS track and coverage.
- Session lists and details agree after refresh; a timeline showing a completed mowing interval is reconciled with the duration summary. Live, incomplete, imported, and unavailable records are distinguished.
- Active errors link from Overview to relevant details. Historical messages are not presented as current faults. Destructive history actions require confirmation and do not erase unrelated records.

### US-12 - Retain Maintenance And Performance Tools

**Priority:** P1

As a mower owner, I want statistics and runtime estimates to remain available so that a simpler navigation structure does not remove maintenance capabilities.

**Acceptance criteria**
- Activity includes a Performance view retaining lifetime counters, blade usage, efficiency metrics, and the runtime estimator.
- Estimation accepts a validated duration and reports estimated cutting time, charging time, and charge stops, together with the data source and fallback status.
- Blade-usage and runtime-sample resets are separate, explicitly named actions with confirmation; their scope is stated before execution.
- Supported mower adjustments and maintenance commands remain reachable under Control; unavailable device capabilities are identified rather than silently failing.

### US-13 - Enter And Leave Winter Mode Intentionally

**Priority:** P1

As a mower owner, I want seasonal advice and deliberate winter-mode controls so that I can suspend the application without confusing that with parking the mower.

**Acceptance criteria**
- Settings retains season dates and manual winter controls; advice is surfaced globally with enter/end and Later actions when applicable.
- Before entering, the UI explains that planning, watchdog operation, and auto-reconnect pause, planned sessions clear, and the firmware calendar remains unchanged. It does not imply that the mower has been physically stopped or stored.
- While active, a persistent global indicator and Overview explain winter mode and its start date. Leaving refreshes the resumed planner and connection states without promising sessions before they exist.
- Snow animation can be disabled per browser and respects reduced-motion preferences. Advice never changes winter mode without user confirmation.

### US-14 - Use The GUI On A Phone Or With Assistive Technology

**Priority:** P1

As a user on a small screen or using assistive technology, I want every core workflow to remain accessible so that device size and input method do not prevent mower control.

**Acceptance criteria**
- Overview, Control, Planning, Activity, and Settings work at 360 px, 390 px, 768 px, and 1280 px widths without page-level horizontal scrolling or obscured content.
- Fixed navigation does not cover focused inputs, action buttons, errors, or the end of scrollable content. Touch targets are at least 44 by 44 CSS pixels for primary controls and navigation.
- All controls work by keyboard with visible focus; icon-only controls have accessible names, form errors are associated with fields, and command feedback is announced without unexpectedly moving focus.
- Text supports 200% zoom. Contrast meets WCAG 2.2 AA, and state is never conveyed solely through color, animation, or icons.

### US-15 - Recognize Demo Mode And Handle Uncertainty

**Priority:** P0

As a tester or mower owner, I want simulation and unavailable data to be unmistakable so that I do not confuse demo results with real mower behavior.

**Acceptance criteria**
- Demo mode has a persistent label in every section and at phone widths. Commands in that mode are routed only through the existing simulator; backend mode determines the behavior.
- Real operation uses authoritative backend data, not concept values or client-side assumptions. Loading, empty, stale, and error states have distinct presentations.
- Demo dates and seeded records are internally consistent or explicitly marked as historical examples; records are not relabeled as fresh results after a failed calculation.
- Integration checks cover disconnect during a command, unavailable weather, invalid configuration, a valid zero-session plan, winter mode, and a failed mode transition.

## Follow-Up Stories

### US-16 - Filter Activity Efficiently

**Priority:** P2

As a mower owner, I want filters by date, event type, and outcome so that I can find a specific incident in a long activity history.

**Acceptance criteria**
- Filters can be combined, cleared together, and preserved when opening and returning from a record.
- No matching records is distinguished from unavailable history. Large datasets use bounded loading rather than rendering all records at once.
- Filtering does not hide active error indicators elsewhere in the GUI.

### US-17 - Reach An Explanation Directly

**Priority:** P2

As a mower owner, I want contextual links from summaries to their evidence so that I can investigate an unexpected state with minimal navigation.

**Acceptance criteria**
- Upcoming-session links open the corresponding Planning detail; latest-activity links open the corresponding Activity record.
- Weather holds link to their measured conditions and thresholds, and growth-related rest days link to the relevant growth explanation.
- Browser Back returns to the originating section and context. Missing or expired records produce a clear explanation rather than an unrelated default record.

## Delivery And Verification

1. Establish a shared server-backed state model and the five-section navigation; implement the P0 state and demo safeguards first.
2. Deliver an end-to-end slice of Overview, Control, and mode-aware Planning, including safe calendar recovery. Do not release mode switching without US-06.
3. Move connection, seasonal configuration, Activity, coverage, and performance tools into their new homes; verify feature parity against the ownership table.
4. Complete responsive/accessibility checks and run the acceptance scenarios in demo mode. Validate actual Bluetooth and hardware-dependent behavior separately before claiming hardware coverage.
5. Add P2 refinements after the core release gates and P1 criteria pass.

Cross-cutting verification must include Smart and Classic modes; connected and disconnected states; mowing, charging, paused, parked, and weather-held states; winter mode; and successful and failed saves/commands. Mower state must remain consistent across navigation and reloads. Changing the information architecture must not silently change planning algorithms or command semantics.

## Backend Dependencies And Decisions

Full contracts with endpoints and payloads are in [BACKEND_CONTRACTS.md](BACKEND_CONTRACTS.md). Summary by story:

| Story | Contracts |
| --- | --- |
| US-02, US-03, US-15 | C-01 status vocabulary, C-03 freshness |
| US-04, US-05 | C-04 command lifecycle, C-08 duration limits |
| US-06 | C-05 calendar backup and restore |
| US-07, US-09 | C-02 decision codes, C-10 daily target, C-11 watchdog states |
| US-11, US-16 | C-06 events, C-09 session durations |
| US-12 | C-07 capabilities (no cutting-height control; the library has no model-to-feature map) |

- Confirm whether calendar backup and restoration are already supported. US-06 may require backend work; a frontend-only warning is not sufficient recovery.
- Resolve the observed session-duration discrepancy at its owning calculation or persistence layer rather than altering the UI to conceal it. C-09 lists the candidate causes found in the code; none is confirmed on live data yet.
- Reuse existing APIs where available. Confirm available command-event history, capability metadata, and freshness timestamps before committing to unsupported detail views.
- Define validated device-specific ranges and a shared status vocabulary from actual backend contracts. Never infer support solely from the illustrated 450X.