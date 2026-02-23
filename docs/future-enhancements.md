# Future Enhancements

## 1) Command Bar (Global AI Chat)
- **Feature:** Add an always-available command bar for direct chat with the coordinator agent, with persistent history.
- **Why we might need it:** Gives a fast control surface for asking questions, issuing orchestration commands, and handling cross-ticket coordination without opening a specific ticket.

## 2) Ticket Comment Mentions (`@agent`)
- **Feature:** Support `@mentions` inside ticket comments to notify or spawn specific agents for targeted input.
- **Why we might need it:** Reduces routing friction and lets humans pull specialist help into an active thread instantly.

## 3) Action Items / Blockers System
- **Feature:** Add structured action items on tickets (`question`, `blocker`, `completion`) with resolve/unresolve/archive states.
- **Why we might need it:** Converts scattered comments into explicit work items and decisions, improving accountability and review clarity.

## 4) Comment Actions (Reply / Delete / Thread Context)
- **Feature:** Add per-comment actions such as reply quoting, contextual reply previews, and delete (permission-controlled).
- **Why we might need it:** Improves discussion quality in long ticket threads and helps teams keep conversation clean and traceable.

## 5) Attachments in Comments and Chat
- **Feature:** Upload and render attachments (images/docs) in ticket discussions and assistant chat surfaces.
- **Why we might need it:** Many tasks depend on screenshots, diagrams, logs, and artifacts that are hard to communicate as plain text.

## 6) Agent Work Lifecycle APIs
- **Feature:** Introduce explicit lifecycle endpoints/events (`start work`, `stop work`, `outcome`) tied to ticket state.
- **Why we might need it:** Makes automation state observable and deterministic, improving dashboards, auditing, and agent handoffs.

## 7) Session Management Panel
- **Feature:** Add controls to list/create/stop/terminate agent sessions and inspect current runtime state.
- **Why we might need it:** Needed for operational safety, debugging stuck sessions, and managing concurrency when many agents run in parallel.

## 8) Security Hardening for API Access
- **Feature:** Add optional API key enforcement and IP allow-listing for sensitive endpoints.
- **Why we might need it:** Protects agent-control surfaces from unauthorized access in shared/dev environments.

## 9) Hard Delete for Tickets (Optional)
- **Feature:** Add irreversible delete endpoint/flow in addition to archive, with confirmation and role checks.
- **Why we might need it:** Useful for accidental/test data cleanup and data hygiene in long-running instances.

## 10) Lane Sorting Controls
- **Feature:** Per-lane sorting modes (priority, latest update, assignee, manual/custom order).
- **Why we might need it:** Different teams optimize for different views; sorting controls improve day-to-day triage speed.

## 11) Export Conversation / Activity to Markdown
- **Feature:** Export selected comments or agent chat to `.md` for sharing or archival.
- **Why we might need it:** Supports stakeholder updates, compliance trails, and preserving high-value implementation context.

## 12) Richer Cross-Ticket Ops Dashboard
- **Feature:** Expand activity view with filters, saved views, and escalation indicators (e.g., stale blockers, unanswered questions).
- **Why we might need it:** As ticket volume grows, teams need rapid situational awareness without opening each ticket.
