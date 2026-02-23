# ClawDesk

## What Is Implemented

### Board + Workflow
- Kanban board with statuses:
  - `Todo`
  - `Plan`
  - `In Progress`
  - `Review`
  - `Done`
- Drag-and-drop ticket movement across lanes.
- Archive action (tickets removed from active board and shown in Archived view).
- Ticket create, edit, assign, reprioritize.
- Real-time board refresh via WebSocket events.

### Ticket Detail
- Right-side task detail drawer with:
  - Editable fields: title, description, assignee, priority
  - Tabs: `Comments`, `History`, `Activity`
  - Task docs panel (links to associated task docs)
- Drawer is resizable by dragging the left edge.

### Activity + History
- Dedicated Activity page (`/log`, labeled “Activity” in UI).
- Per-ticket events and global activity stream.

### Workspace (File Studio)
- Workspace tree for browsing files/directories.
- Open, edit, auto-save UTF-8 text files.
- Markdown rich editor + raw markdown + split mode.
- Non-markdown files default to edit mode (not split).
- Image preview support.
- Create new file, delete file.
- Deep-link support: `?/open=<workspace-relative-path>`.

### OpenClaw Gateway Integration
- Gateway health check endpoint.
- Agent directory endpoint with 1-hour TTL cache.
- Ticket automation:
  - On move into `Plan` or `In Progress`, backend attempts `sessions_spawn`.
  - On new comments in `Plan` or `In Progress`, backend attempts `sessions_send` to active session.
- Automation failures are recorded as comments/events; ticket move still succeeds.

## Architecture

### Backend
- FastAPI app: `backend/main.py`
- SQLite DB: `data/kanban.db`
- WebSocket endpoint: `/ws`
- Serves built frontend from `frontend/dist` at `/` (if built)

### Frontend
- React + TypeScript + Vite: `frontend/`
- Routing (React Router):
  - `/dashboard`
  - `/workspace`
  - `/log` (UI label: Activity)
  - `/settings` (placeholder)
  - `/archived`
- API hooks and typed client in:
  - `frontend/src/api/client.ts`
  - `frontend/src/hooks/api.ts`

### Data Flow
- REST for CRUD and workspace operations.
- WebSocket for real-time updates (`ticket_created`, `ticket_updated`, `ticket_moved`, `ticket_archived`, `comment_added`, `ticket_event`).

## Workflow and Status Rules

Current allowed transitions are enforced server-side:

- `Plan` -> `Todo`, `In Progress`, `Review`, `Done`
- `Todo` -> `Plan`, `In Progress`, `Review`, `Done`
- `In Progress` -> `Plan`, `Todo`, `Review`, `Done`
- `Review` -> `Plan`, `Todo`, `In Progress`, `Done`
- `Done` -> `Plan`, `Todo`, `Review`

Notes:
- Tickets are created in `Plan` by default.
- Archived tickets cannot be moved.

## Agent Instructions

This section is derived from `docs/agent-instructions.md` and aligned to current backend behavior.

### Scope
- Humans control assignment and primary workflow routing.
- Agents are expected to execute work when a ticket is in:
  - `Plan`
  - `In Progress`
- Agents should not auto-act in:
  - `Todo`
  - `Review`
  - `Done`

### Required Start Sequence
Before starting work on any ticket:
1. Read ticket details.
2. Read all ticket comments.
3. Pay extra attention to the latest comment for changed scope/instructions.

### Behavior by Status
- `Plan`:
  - Do planning/analysis only.
  - Produce planning artifacts.
  - Comment summary and artifact paths.
  - Move ticket to `Review` when planning is complete.
- `In Progress`:
  - Implement requested change.
  - Post progress and artifact updates.
  - Move ticket to `Review` when implementation is complete.

### Comment Prefixes
Use concise prefixes for scanability:
- `PLAN:`
- `PROGRESS:`
- `ARTIFACT:`
- `BLOCKER:`
- `REVIEW:`

### Completion Minimum
Before moving to `Review`, agent should:
1. Post at least one summary comment.
2. Link artifacts produced.
3. Include validation/check notes.

### Documentation Expectations
For substantial work, use:
- `docs/task-<ticket_id>-<slug>/`

Typical files:
- Planning: `analysis.md`
- Implementation: `implementation-notes.md`
- Optional handoff: `review-notes.md`

Task docs linkage behavior in code:
- `GET /api/tickets/{id}/docs` scans `docs/task-<id>-*`.
- Renaming a ticket attempts to rename matching task-docs folder to the new slug (safe move only).

### Agent API Operations
Base URL:
- `http://127.0.0.1:8080` (or `http://localhost:8080`)

Read context:
- `GET /api/tickets?archived=false` (active tickets only)
- `GET /api/tickets/{ticket_id}`
- `GET /api/tickets/{ticket_id}/comments`
- Optional: `GET /api/tickets/{ticket_id}/events`

Manage work:
- Create ticket: `POST /api/tickets`
- Reassign: `PATCH /api/tickets/{ticket_id}` with `{"assignee":"<agent_name>"}`.
- Comment: `POST /api/tickets/{ticket_id}/comments`
- Move to review: `POST /api/tickets/{ticket_id}/move?status=Review&actor=<agent_name>`

### Automation Trigger Notes
Backend automation currently triggers when status enters:
- `Plan`
- `In Progress`

For tickets in those statuses, new comments are forwarded to active agent sessions when possible.
No automation trigger is expected for `Todo`, `Review`, or `Done`.

## Environment Variables

Root `.env` is used by backend and frontend dev (Vite uses `envDir: '..'`).

Required for full OpenClaw integration:
- `OPENCLAW_GATEWAY_URL` (example: `http://127.0.0.1:18789`)
- `OPENCLAW_TOKEN` (raw token; no `Bearer ` prefix)

Common variables:
- `VITE_API_BASE_URL=http://localhost:8080`
- `PORT=8080` (optional; if omitted, backend derives port from `VITE_API_BASE_URL`)
- `WORKSPACE_BROWSER_ROOT=.../.openclaw/workspace`
- `WORKSPACE_MAX_FILE_BYTES=2097152` (default 2MB)

Token alias supported by backend:
- `GATEWAY_AUTH_TOKEN`

## Local Setup

### 1) Backend
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 8080 --reload
```

### 2) Frontend (dev)
```bash
cd frontend
npm install
npm run dev
```

Frontend default URL:
- `http://localhost:5173`

Backend default URL:
- `http://localhost:8080`

### 3) Production-style single host (optional)
Build frontend then run backend:
```bash
cd frontend
npm run build
cd ..
uvicorn backend.main:app --host 0.0.0.0 --port 8080
```
Then open:
- `http://localhost:8080`

## API Reference (Current)

### Health and Config
- `GET /api/health`
- `GET /api/config`
- `GET /api/gateway/health`
- `GET /api/agents?force_refresh=false`

### Tickets
- `GET /api/tickets?status=&assignee=&archived=false`
- `GET /api/tickets/{ticket_id}`
- `POST /api/tickets`
- `PATCH /api/tickets/{ticket_id}`
- `POST /api/tickets/{ticket_id}/move?status=<Status>&actor=<Actor>`
- `POST /api/tickets/{ticket_id}/archive?actor=<Actor>`

### Ticket Collaboration
- `GET /api/tickets/{ticket_id}/comments`
- `POST /api/tickets/{ticket_id}/comments`
- `GET /api/tickets/{ticket_id}/events`
- `GET /api/tickets/{ticket_id}/docs`

### Activity
- `GET /api/activity?limit=250&offset=0&ticket_id=&event_type=&include_archived=false`

### Workspace
- `GET /api/workspace/list?path=&include_hidden=false`
- `GET /api/workspace/file?path=<relative_path>`
- `GET /api/workspace/content?path=<relative_image_path>`
- `POST /api/workspace/file`
- `PUT /api/workspace/file`
- `DELETE /api/workspace/file?path=<relative_path>`

### Realtime
- `WS /ws`
- Supports simple ping/pong (`ping` -> `pong`) and server broadcasts.

## Database Schema

SQLite file:
- `data/kanban.db`

Tables:
- `tickets`
  - `id, title, description, status, assignee, priority, agent_session_key, archived_at, created_at, updated_at`
- `ticket_events`
  - `id, ticket_id, event_type, actor, details, created_at`
- `ticket_comments`
  - `id, ticket_id, author, content, created_at`

Indexes include status, updated time, archived time, and ticket foreign-key lookups.

## Frontend Routes and Notes

- `/dashboard`: main board + DnD + ticket drawer
- `/workspace`: file studio
- `/log`: activity stream page (shown as “Activity” in nav)
- `/settings`: placeholder page
- `/archived`: archived tickets table + open ticket detail

## Gateway Requirements / Troubleshooting

For automation to work, gateway must allow relevant tools:
- `agents_list`
- `sessions_spawn`
- `sessions_send`

If `/tools/invoke` rejects tools, update gateway policy accordingly.

If UI shows backend connectivity errors:
- Confirm backend is running on `PORT`.
- Confirm `VITE_API_BASE_URL` points at backend.
- Confirm browser can reach `OPENCLAW_GATEWAY_URL` from backend host.

## Development Notes

- Root `.env` is the canonical env file.
- `frontend/.env.example` only documents frontend override and is optional.
- UI theme lives mainly in:
  - `frontend/src/design/tokens.css`
  - `frontend/src/App.css`
