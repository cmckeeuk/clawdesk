# Sessions UX Redesign Proposal

## Problem Statement

Current Sessions monitoring works for small volume, but breaks down when many agents and sessions exist.

Observed pain points:
- Hard to see agents other than `main`.
- Session cards look similar, so session boundaries are unclear.
- No clear hierarchy between agent and session.
- Important sessions (running/error) are buried in a long flat list.
- At 20 agents x 10 sessions, the page becomes noisy and slow to scan.

Likely root causes in current behavior:
- Flat session list sorted by most recent activity.
- Default fetch limit (`session_limit=24`) may hide older/less-active sessions.
- Command history is fetched for every visible session, which adds visual and data volume at once.

## UX Goals

- Make agent separation obvious first, session detail second.
- Surface critical sessions immediately (running/error/stuck).
- Support fast narrowing by agent, status, ticket, and channel.
- Keep default view low-noise and expandable on demand.
- Scale comfortably to 200 sessions without cognitive overload.

## Information Architecture

Adopt a 3-pane layout:

1. Agent Rail (left)
- Search agents.
- List agents with counts:
  - Total sessions
  - Running
  - Errors
  - Idle
- Multi-select agents.
- Quick filter chips: `All`, `With Errors`, `Running`, `Idle`.

2. Session List (center)
- Group sessions under collapsible agent sections.
- Sticky group header per agent.
- Group header summary:
  - Agent name/id
  - `sessions`, `running`, `errors`, `last update`
- Session row compact by default:
  - Status dot + label
  - Short session key
  - Channel/model
  - Linked ticket count
  - Last command preview (single line)
  - Relative updated time
- Expand row to reveal command timeline preview.

3. Session Detail Panel (right)
- Opens on selected session.
- Full command timeline and metadata.
- Linked tickets list with quick open.
- Errors/history failures with actionable text.

## Visual and Interaction Model

### Agent-first Grouping
- Default sort: agents with errors first, then running, then most recently updated.
- Within each agent: running sessions first, then error, then idle by recency.

### Collapsing Rules
- Initial state:
  - Expand only agents with `running > 0` or `errors > 0`.
  - Collapse all fully idle agents.
- Provide controls:
  - `Expand all agents`
  - `Collapse all agents`
  - `Expand critical only`

### Session Identity Clarity
- Render session label as:
  - `AgentName / Channel / ShortSessionId`
- Show full key only in tooltip/detail.
- Distinguish session status with color + icon + text (not color alone).

### Filtering
- Global filters:
  - Agent (multi-select)
  - Session status (`running`, `error`, `idle`, `unknown`)
  - Ticket id / assignee
  - Channel
  - Has command activity
  - Has history fetch error
- Keep active filters visible as removable chips.
- Save and recall views:
  - `All`
  - `Critical`
  - `My agents`

### Search
- Search over:
  - Agent name/id
  - Session key
  - Ticket id/title
  - Command text preview
- Highlight matched fields in session rows.

## High-Scale Behavior (20 x 10)

### Performance Strategy
- Use virtualized rendering for agent groups and session rows.
- Do not fetch full command history for all sessions on first load.
- First load should fetch summary only, then fetch history lazily when:
  - Session row is expanded, or
  - Session is selected in detail panel.

### Data Fetch Strategy
- New recommended API split:
  - `GET /api/gateway/sessions/summary` (all sessions, no history payload)
  - `GET /api/gateway/sessions/{session_key}/commands?limit=...` (on demand)
- Keep existing `sessions/activity` for backward compatibility, but avoid as primary path for large scale.

### Default Limits
- Increase default session list limit to cover real-world scale (for example 200).
- Keep command history default low for on-demand fetch (for example 40).

## Suggested UI States

- Empty:
  - “No sessions match filters” + one-click clear filters.
- Partial failure:
  - Show sessions summary even if command history fails for some sessions.
  - Per-session inline error badge and retry action.
- Stale data:
  - Show “Last updated Xs ago” with refresh and auto-refresh status.

## Accessibility and Ops Usability

- Keyboard navigation:
  - Arrow keys for row navigation
  - Enter to expand/collapse
  - `f` to focus filter/search
- Use semantic sections:
  - Agent list, session list, detail panel landmarks.
- Ensure status is communicated in text and iconography, not color only.

## Rollout Plan

Phase 1: Quick wins (low risk)
- Agent grouping + collapsible sections.
- Critical-first sort.
- Filter chips and agent multi-select.
- Expand/collapse controls.

Phase 2: Scale and clarity
- Split summary vs commands API calls.
- Lazy-load command history per session.
- Virtualized list rendering.

Phase 3: Power-operator features
- Saved views.
- Alert-focused mode (errors/running only).
- Session comparison view (two selected sessions side-by-side).

## Acceptance Criteria

- User can isolate one agent’s sessions in <=2 interactions.
- User can identify all agents with errors in one screen without scrolling.
- At 200 sessions, initial render remains responsive and readable.
- Session identity (agent + channel + key) is unambiguous in list rows.
- Idle sessions do not dominate the default view.
