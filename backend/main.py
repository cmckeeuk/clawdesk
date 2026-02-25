import json
import time
import os
import re
import sqlite3
import asyncio
import tempfile
import shutil
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from urllib.parse import unquote, urlparse

import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator


BASE_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIST_DIR = BASE_DIR / "frontend" / "dist"
DATA_DIR = BASE_DIR / "data"
DEFAULT_DB_PATH = DATA_DIR / "kanban.db"
DOTENV_PATH = BASE_DIR / ".env"

DATA_DIR.mkdir(exist_ok=True)


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue

        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]

        os.environ.setdefault(key, value)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


load_dotenv(DOTENV_PATH)

DB_PATH = Path(os.getenv("KANBAN_DB_PATH", str(DEFAULT_DB_PATH))).expanduser().resolve()
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def infer_port(default: int = 8080) -> int:
    raw_port = os.getenv("PORT", "").strip()
    if raw_port:
        try:
            return int(raw_port)
        except ValueError:
            raise RuntimeError(f"Invalid PORT value: {raw_port!r}")

    raw_base = os.getenv("VITE_API_BASE_URL", "").strip()
    if raw_base:
        parsed = urlparse(raw_base if "://" in raw_base else f"http://{raw_base}")
        if parsed.port is not None:
            return int(parsed.port)

    return default


OPENCLAW_GATEWAY_URL = os.getenv("OPENCLAW_GATEWAY_URL", "").strip().rstrip("/")
OPENCLAW_TOKEN = os.getenv("OPENCLAW_TOKEN", "").strip()
PORT = infer_port(8080)
API_BASE_URL = os.getenv("VITE_API_BASE_URL", "").strip().rstrip("/")
if not API_BASE_URL:
    API_BASE_URL = f"http://localhost:{PORT}"
FRONTEND_URL = os.getenv("FRONTEND_URL", "").strip().rstrip("/")
CORS_ALLOW_ORIGINS = [FRONTEND_URL] if FRONTEND_URL else []
CORS_ALLOW_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"]
CORS_ALLOW_HEADERS = ["Authorization", "Content-Type"]
CORS_ALLOW_CREDENTIALS = True
AGENT_CACHE_TTL_SECONDS = 60 * 60
DEFAULT_WORKSPACE_ROOT = BASE_DIR.parent.parent
WORKSPACE_ROOT = Path(os.getenv("WORKSPACE_BROWSER_ROOT", str(DEFAULT_WORKSPACE_ROOT))).expanduser().resolve()
WORKSPACE_MAX_FILE_BYTES = int(os.getenv("WORKSPACE_MAX_FILE_BYTES", str(2 * 1024 * 1024)))
WORKSPACE_SKIP_DIRS = {"node_modules", ".git", ".venv", "__pycache__"}
WORKSPACE_IMAGE_SUFFIXES = {
    ".avif",
    ".bmp",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".tif",
    ".tiff",
    ".webp",
}


def is_path_within(path: Path, ancestor: Path) -> bool:
    try:
        path.relative_to(ancestor)
        return True
    except ValueError:
        return False


WORKSPACE_READ_ROOTS: List[Path] = []
if WORKSPACE_ROOT != DEFAULT_WORKSPACE_ROOT and is_path_within(WORKSPACE_ROOT, DEFAULT_WORKSPACE_ROOT):
    WORKSPACE_READ_ROOTS.extend([DEFAULT_WORKSPACE_ROOT, WORKSPACE_ROOT])
else:
    WORKSPACE_READ_ROOTS.append(WORKSPACE_ROOT)
    if DEFAULT_WORKSPACE_ROOT != WORKSPACE_ROOT:
        WORKSPACE_READ_ROOTS.append(DEFAULT_WORKSPACE_ROOT)

STATUSES = ["Todo", "Plan", "In Progress", "Review", "Done"]
PRIORITIES = ["Critical", "High", "Medium", "Low"]
AUTOMATION_TRIGGER_STATUSES = {"Plan", "In Progress"}
ALLOWED_TRANSITIONS = {
    "Plan": {"Todo", "In Progress", "Review", "Done"},
    "Todo": {"Plan", "In Progress", "Review", "Done"},
    "In Progress": {"Plan", "Todo", "Review", "Done"},
    "Review": {"Plan", "Todo", "In Progress", "Done"},
    "Done": {"Plan", "Todo", "Review"},
}
COMMAND_MONITOR_TOOL_NAMES = {"exec", "process", "bash", "shell"}
COMMAND_MONITOR_TOOL_BLOCK_TYPES = {"tooluse", "tool_use", "toolcall", "tool_call"}


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    async def broadcast(self, payload: Dict[str, Any]) -> None:
        dead: List[WebSocket] = []
        for connection in self.connections:
            try:
                await connection.send_json(payload)
            except Exception:
                dead.append(connection)
        for connection in dead:
            self.disconnect(connection)


manager = ConnectionManager()
agent_cache_lock = asyncio.Lock()
agent_cache: Dict[str, Any] = {
    "agents": None,
    "fetched_at": 0.0,
    "expires_at": 0.0,
}


@contextmanager
def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tickets (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              description TEXT DEFAULT '',
              status TEXT NOT NULL DEFAULT 'Todo',
              assignee TEXT DEFAULT 'Unassigned',
              priority TEXT DEFAULT 'Medium',
              agent_session_key TEXT,
              archived_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ticket_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ticket_id INTEGER NOT NULL,
              event_type TEXT NOT NULL,
              actor TEXT,
              details TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(ticket_id) REFERENCES tickets(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ticket_comments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ticket_id INTEGER NOT NULL,
              author TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(ticket_id) REFERENCES tickets(id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tickets_updated_at ON tickets(updated_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tickets_archived_at ON tickets(archived_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_ticket_id ON ticket_events(ticket_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_created_at ON ticket_events(created_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_comments_ticket_id ON ticket_comments(ticket_id)")
        conn.commit()


def create_event(conn: sqlite3.Connection, ticket_id: int, event_type: str, actor: str, details: str) -> Dict[str, Any]:
    ts = now_iso()
    cursor = conn.execute(
        "INSERT INTO ticket_events (ticket_id, event_type, actor, details, created_at) VALUES (?, ?, ?, ?, ?)",
        (ticket_id, event_type, actor, details, ts),
    )
    return {
        "id": cursor.lastrowid,
        "ticket_id": ticket_id,
        "event_type": event_type,
        "actor": actor,
        "details": details,
        "created_at": ts,
    }


def create_comment(conn: sqlite3.Connection, ticket_id: int, author: str, content: str) -> Dict[str, Any]:
    ts = now_iso()
    cursor = conn.execute(
        "INSERT INTO ticket_comments (ticket_id, author, content, created_at) VALUES (?, ?, ?, ?)",
        (ticket_id, author, content, ts),
    )
    return {
        "id": cursor.lastrowid,
        "ticket_id": ticket_id,
        "author": author,
        "content": content,
        "created_at": ts,
    }


def row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return dict(row)


def normalize_workspace_relative_path(path_value: str) -> str:
    raw = path_value.strip()
    for _ in range(2):
        decoded = unquote(raw)
        if decoded == raw:
            break
        raw = decoded

    return raw.replace("\\", "/")


def resolve_under_workspace_root(path_value: str, root: Path) -> Path:
    raw = normalize_workspace_relative_path(path_value)
    if raw in {"", "."}:
        return root

    candidate = (root / raw).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="path escapes workspace root") from exc

    return candidate


def resolve_workspace_path(path_value: str) -> Path:
    return resolve_under_workspace_root(path_value, WORKSPACE_ROOT)


def resolve_workspace_path_for_read(path_value: str, expected_kind: str = "any") -> tuple[Path, Path]:
    last_candidate: Optional[Path] = None
    for root in WORKSPACE_READ_ROOTS:
        candidate = resolve_under_workspace_root(path_value, root)
        last_candidate = candidate
        if not candidate.exists():
            continue
        if expected_kind == "file" and not candidate.is_file():
            continue
        if expected_kind == "dir" and not candidate.is_dir():
            continue
        return candidate, root

    if last_candidate is None:
        raise HTTPException(status_code=404, detail="path not found")
    if not last_candidate.exists():
        raise HTTPException(status_code=404, detail="path not found")
    if expected_kind == "file" and not last_candidate.is_file():
        raise HTTPException(status_code=400, detail="path is not a file")
    if expected_kind == "dir" and not last_candidate.is_dir():
        raise HTTPException(status_code=400, detail="path is not a directory")
    return last_candidate, WORKSPACE_ROOT


def workspace_relative(path: Path, root: Path = WORKSPACE_ROOT) -> str:
    return str(path.relative_to(root)).replace("\\", "/")


def workspace_relative_or_string(path: Path, root: Path = WORKSPACE_ROOT) -> str:
    try:
        return workspace_relative(path, root=root)
    except ValueError:
        return str(path)


def is_markdown_file(path: Path) -> bool:
    return path.suffix.lower() in {".md", ".markdown", ".mdx"}


def is_image_file(path: Path) -> bool:
    return path.suffix.lower() in WORKSPACE_IMAGE_SUFFIXES


def slugify_ticket_title(title: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return normalized or "untitled"


def task_docs_roots() -> List[Path]:
    roots = [
        (WORKSPACE_ROOT / "docs").resolve(),
        (BASE_DIR / "docs").resolve(),
    ]
    deduped: List[Path] = []
    seen: Set[str] = set()
    for root in roots:
        key = str(root)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(root)
    return deduped


def expected_task_docs_dir_for_root(root: Path, ticket_id: int, title: str) -> Path:
    return root / f"task-{ticket_id}-{slugify_ticket_title(title)}"


def default_task_docs_dir(ticket_id: int, title: str) -> Path:
    root = task_docs_roots()[0]
    return expected_task_docs_dir_for_root(root, ticket_id, title)


def find_task_docs_dir(ticket_id: int, preferred_title: Optional[str] = None) -> Optional[Path]:
    roots = task_docs_roots()

    if preferred_title:
        for root in roots:
            preferred = expected_task_docs_dir_for_root(root, ticket_id, preferred_title)
            if preferred.exists() and preferred.is_dir():
                return preferred

    prefix = f"task-{ticket_id}-"
    matches: List[Path] = []
    for root in roots:
        if not root.exists() or not root.is_dir():
            continue
        matches.extend([entry for entry in root.iterdir() if entry.is_dir() and entry.name.startswith(prefix)])

    if not matches:
        return None
    matches.sort(key=lambda entry: entry.name.lower())
    return matches[0]


def list_task_docs_files(folder: Path) -> List[Dict[str, Any]]:
    files: List[Dict[str, Any]] = []
    for file_path in sorted(folder.rglob("*"), key=lambda path: str(path).lower()):
        if not file_path.is_file():
            continue
        stats = file_path.stat()
        files.append(
            {
                "name": file_path.name,
                "path": workspace_relative(file_path),
                "relativePath": str(file_path.relative_to(folder)).replace("\\", "/"),
                "sizeBytes": stats.st_size,
                "updatedAt": datetime.fromtimestamp(stats.st_mtime, tz=timezone.utc).isoformat(),
                "isMarkdown": is_markdown_file(file_path),
                "isImage": is_image_file(file_path),
            }
        )
    return files


def workspace_entry(path: Path, root: Path = WORKSPACE_ROOT) -> Dict[str, Any]:
    stats = path.stat()
    kind = "dir" if path.is_dir() else "file"
    return {
        "name": path.name,
        "path": workspace_relative(path, root=root),
        "type": kind,
        "sizeBytes": stats.st_size if kind == "file" else None,
        "updatedAt": datetime.fromtimestamp(stats.st_mtime, tz=timezone.utc).isoformat(),
        "isMarkdown": is_markdown_file(path) if kind == "file" else False,
        "isImage": is_image_file(path) if kind == "file" else False,
    }


class TicketCreate(BaseModel):
    title: str
    description: str = ""
    assignee: str = "Unassigned"
    priority: str = "Medium"

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("title is required")
        if len(text) > 200:
            raise ValueError("title too long")
        return text

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        if len(value) > 10000:
            raise ValueError("description too long")
        return value

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, value: str) -> str:
        if value not in PRIORITIES:
            raise ValueError(f"priority must be one of {', '.join(PRIORITIES)}")
        return value


class TicketUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    assignee: Optional[str] = None
    priority: Optional[str] = None

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        text = value.strip()
        if not text:
            raise ValueError("title cannot be empty")
        if len(text) > 200:
            raise ValueError("title too long")
        return text

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        if len(value) > 10000:
            raise ValueError("description too long")
        return value

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        if value not in PRIORITIES:
            raise ValueError(f"priority must be one of {', '.join(PRIORITIES)}")
        return value


class CommentCreate(BaseModel):
    author: str
    content: str

    @field_validator("author")
    @classmethod
    def validate_author(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("author is required")
        if len(text) > 100:
            raise ValueError("author too long")
        return text

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("content is required")
        if len(text) > 10000:
            raise ValueError("content too long")
        return text


class WorkspaceFileUpdate(BaseModel):
    path: str
    content: str

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("path is required")
        if len(text) > 1024:
            raise ValueError("path too long")
        if text.startswith("/"):
            raise ValueError("path must be workspace-relative")
        return text


class WorkspaceFileCreate(BaseModel):
    path: str
    content: str = ""

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("path is required")
        if len(text) > 1024:
            raise ValueError("path too long")
        if text.startswith("/"):
            raise ValueError("path must be workspace-relative")
        return text


app = FastAPI(title="OpenClaw Kanban", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=CORS_ALLOW_CREDENTIALS,
    allow_methods=CORS_ALLOW_METHODS,
    allow_headers=CORS_ALLOW_HEADERS,
)

if FRONTEND_DIST_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIST_DIR), name="static")


async def call_openclaw_tool(tool: str, args: Dict[str, Any], timeout_seconds: float = 60.0) -> Dict[str, Any]:
    if not OPENCLAW_TOKEN:
        raise HTTPException(status_code=400, detail="OPENCLAW_TOKEN is not configured")

    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {"tool": tool, "args": args}

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(
                f"{OPENCLAW_GATEWAY_URL}/tools/invoke",
                json=payload,
                headers=headers,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Gateway request failed: {exc}") from exc

    if response.status_code != 200:
        detail = response.text[:400] if response.text else f"HTTP {response.status_code}"
        raise HTTPException(status_code=502, detail=f"Gateway error: {detail}")

    try:
        body = response.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Gateway returned invalid JSON") from exc

    if not body.get("ok"):
        raise HTTPException(status_code=502, detail=f"Gateway invoke failed: {body}")

    return body


def normalize_agent_records(raw_agents: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_agents, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for item in raw_agents:
        if not isinstance(item, dict):
            continue

        agent_id = str(item.get("id", "")).strip()
        if not agent_id:
            continue

        name_raw = item.get("name")
        name = str(name_raw).strip() if isinstance(name_raw, str) else None
        configured_raw = item.get("configured", True)
        configured = bool(configured_raw) if isinstance(configured_raw, bool) else True

        normalized.append(
            {
                "id": agent_id,
                "name": name if name else None,
                "configured": configured,
            }
        )

    return sorted(normalized, key=lambda value: value["id"].lower())


def parse_agents_list_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    result = response.get("result", {})
    if not isinstance(result, dict):
        return []

    details = result.get("details", {})
    if isinstance(details, dict) and "agents" in details:
        return normalize_agent_records(details.get("agents"))

    content = result.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if not isinstance(text, str):
                continue
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and "agents" in parsed:
                return normalize_agent_records(parsed.get("agents"))

    return []


async def fetch_gateway_agents_uncached() -> List[Dict[str, Any]]:
    response = await call_openclaw_tool("agents_list", {}, timeout_seconds=12.0)
    return parse_agents_list_response(response)


async def get_cached_gateway_agents(force_refresh: bool = False) -> Dict[str, Any]:
    now = time.time()
    cached_agents = agent_cache.get("agents")
    expires_at = float(agent_cache.get("expires_at", 0.0) or 0.0)
    if not force_refresh and cached_agents is not None and now < expires_at:
        return {
            "agents": cached_agents,
            "fetched_at": float(agent_cache.get("fetched_at", 0.0) or 0.0),
            "expires_at": expires_at,
            "cached": True,
            "stale": False,
        }

    async with agent_cache_lock:
        now = time.time()
        cached_agents = agent_cache.get("agents")
        expires_at = float(agent_cache.get("expires_at", 0.0) or 0.0)
        if not force_refresh and cached_agents is not None and now < expires_at:
            return {
                "agents": cached_agents,
                "fetched_at": float(agent_cache.get("fetched_at", 0.0) or 0.0),
                "expires_at": expires_at,
                "cached": True,
                "stale": False,
            }

        try:
            agents = await fetch_gateway_agents_uncached()
        except HTTPException:
            if cached_agents is not None:
                return {
                    "agents": cached_agents,
                    "fetched_at": float(agent_cache.get("fetched_at", 0.0) or 0.0),
                    "expires_at": expires_at,
                    "cached": True,
                    "stale": True,
                }
            raise

        fetched_at = time.time()
        next_expiry = fetched_at + AGENT_CACHE_TTL_SECONDS
        agent_cache["agents"] = agents
        agent_cache["fetched_at"] = fetched_at
        agent_cache["expires_at"] = next_expiry

        return {
            "agents": agents,
            "fetched_at": fetched_at,
            "expires_at": next_expiry,
            "cached": False,
            "stale": False,
        }


def fallback_assignee_options() -> List[str]:
    return ["Unassigned"]


def assignee_options_from_agents(agents: List[Dict[str, Any]]) -> List[str]:
    options = {"Unassigned"}
    for agent in agents:
        if agent.get("configured") is False:
            continue
        agent_id = str(agent.get("id", "")).strip()
        if agent_id:
            options.add(agent_id)
    return sorted(options, key=str.lower)


def match_agent_id_from_directory(assignee: str, agents: List[Dict[str, Any]]) -> Optional[str]:
    assignee_lower = assignee.strip().lower()
    if not assignee_lower:
        return None

    for agent in agents:
        if agent.get("configured") is False:
            continue
        candidate_id = str(agent.get("id", "")).strip()
        if not candidate_id:
            continue
        candidate_name = str(agent.get("name") or "").strip()
        if assignee_lower == candidate_id.lower() or (candidate_name and assignee_lower == candidate_name.lower()):
            return candidate_id

    return None


async def resolve_assignee_agent_id_from_directory(assignee: str) -> Optional[str]:
    assignee = assignee.strip()
    if not assignee or assignee.lower() == "unassigned":
        return None

    if not OPENCLAW_TOKEN:
        return None

    try:
        directory = await get_cached_gateway_agents(force_refresh=False)
    except HTTPException:
        return None

    agent_id = match_agent_id_from_directory(assignee, directory.get("agents", []))
    if agent_id:
        return agent_id

    return None


async def resolve_assignee_agent_id(assignee: str) -> Optional[str]:
    return await resolve_assignee_agent_id_from_directory(assignee)


def parse_sessions_list_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    result = response.get("result", {}) if isinstance(response, dict) else {}
    if not isinstance(result, dict):
        return []

    details = result.get("details")
    if isinstance(details, dict):
        for key in ("sessions", "items"):
            items = details.get(key)
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]

    content = result.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if not isinstance(text, str):
                continue
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                for key in ("sessions", "items"):
                    items = parsed.get(key)
                    if isinstance(items, list):
                        return [entry for entry in items if isinstance(entry, dict)]
            if isinstance(parsed, list):
                return [entry for entry in parsed if isinstance(entry, dict)]

    return []


def parse_tool_result_details(response: Dict[str, Any]) -> Dict[str, Any]:
    result = response.get("result", {}) if isinstance(response, dict) else {}
    if not isinstance(result, dict):
        return {}

    details = result.get("details")
    if isinstance(details, dict):
        return details

    content = result.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if not isinstance(text, str):
                continue
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed

    return {}


def parse_sessions_history_messages(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    details = parse_tool_result_details(response)
    messages = details.get("messages")
    if isinstance(messages, list):
        return [message for message in messages if isinstance(message, dict)]
    return []


def normalize_gateway_timestamp(value: Any) -> Dict[str, Any]:
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts <= 0:
            return {"iso": None, "ms": None}
        ts_ms = int(ts if ts > 1_000_000_000_000 else ts * 1000)
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat()
        return {"iso": dt, "ms": ts_ms}

    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return {"iso": None, "ms": None}
        parsed_dt: Optional[datetime] = None
        try:
            parsed_dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            parsed_dt = None
        if parsed_dt is None:
            return {"iso": raw, "ms": None}
        if parsed_dt.tzinfo is None:
            parsed_dt = parsed_dt.replace(tzinfo=timezone.utc)
        parsed_utc = parsed_dt.astimezone(timezone.utc)
        return {"iso": parsed_utc.isoformat(), "ms": int(parsed_utc.timestamp() * 1000)}

    return {"iso": None, "ms": None}


def content_preview(value: Any, max_chars: int = 500) -> Optional[str]:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        return text[:max_chars]

    if not isinstance(value, list):
        return None

    parts: List[str] = []
    for block in value:
        if not isinstance(block, dict):
            continue
        text = block.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
            continue
        partial = block.get("partialJson")
        if isinstance(partial, str) and partial.strip():
            parts.append(partial.strip())

    if not parts:
        return None
    return "\n".join(parts)[:max_chars]


def command_input_summary(value: Any) -> Optional[str]:
    if isinstance(value, str):
        text = value.strip()
        return text[:500] if text else None

    if not isinstance(value, dict):
        return None

    command = value.get("command")
    if isinstance(command, str) and command.strip():
        return command.strip()[:500]

    action = value.get("action")
    session_id = value.get("sessionId")
    if isinstance(action, str) and action.strip():
        if isinstance(session_id, str) and session_id.strip():
            return f"action={action.strip()} sessionId={session_id.strip()}"[:500]
        return f"action={action.strip()}"[:500]

    compact = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    return compact[:500] if compact else None


def infer_command_result_status(message: Dict[str, Any], preview: Optional[str]) -> str:
    if bool(message.get("isError")):
        return "error"

    text = (preview or "").lower()
    if "command still running" in text:
        return "running"

    exit_match = re.search(r"exited with code\\s+(-?\\d+)", text)
    if exit_match:
        try:
            code = int(exit_match.group(1))
        except ValueError:
            code = 1
        return "success" if code == 0 else "error"

    if "http error" in text or text.startswith("error:") or "traceback" in text:
        return "error"
    if preview:
        return "success"
    return "unknown"


def infer_agent_id_from_session_key(session_key: str) -> Optional[str]:
    key = session_key.strip()
    if key.startswith("agent:"):
        parts = key.split(":")
        if len(parts) >= 2 and parts[1]:
            return parts[1]
    return None


def extract_command_runs(messages: List[Dict[str, Any]], max_runs: int = 120) -> List[Dict[str, Any]]:
    runs_by_call_id: Dict[str, Dict[str, Any]] = {}
    creation_order: List[str] = []
    synthetic_counter = 0

    def ensure_run(call_id: str, tool_name: str, index: int) -> Dict[str, Any]:
        run = runs_by_call_id.get(call_id)
        if run is not None:
            if not run.get("toolName"):
                run["toolName"] = tool_name
            return run

        run = {
            "callId": call_id,
            "toolName": tool_name,
            "status": "running",
            "command": None,
            "preview": None,
            "startedAt": None,
            "finishedAt": None,
            "updatedAt": None,
            "startedAtMs": None,
            "updatedAtMs": None,
            "index": index,
        }
        runs_by_call_id[call_id] = run
        creation_order.append(call_id)
        return run

    for index, message in enumerate(messages):
        role = str(message.get("role") or "")
        timestamp = normalize_gateway_timestamp(message.get("timestamp"))
        timestamp_iso = timestamp.get("iso")
        timestamp_ms = timestamp.get("ms")

        if role in {"assistant", "tool"}:
            content = message.get("content")
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    block_type = str(block.get("type") or "").strip().lower()
                    if block_type not in COMMAND_MONITOR_TOOL_BLOCK_TYPES:
                        continue
                    tool_name = str(block.get("name") or block.get("toolName") or "").strip().lower()
                    if tool_name not in COMMAND_MONITOR_TOOL_NAMES:
                        continue

                    raw_call_id = block.get("id") or block.get("toolCallId")
                    call_id = str(raw_call_id).strip() if raw_call_id is not None else ""
                    if not call_id:
                        synthetic_counter += 1
                        call_id = f"req-{index}-{synthetic_counter}"

                    run = ensure_run(call_id, tool_name, index)
                    command_text = command_input_summary(
                        block.get("input") or block.get("arguments") or block.get("args")
                    )
                    if command_text:
                        run["command"] = command_text
                    if timestamp_iso and not run.get("startedAt"):
                        run["startedAt"] = timestamp_iso
                    if timestamp_ms is not None and run.get("startedAtMs") is None:
                        run["startedAtMs"] = timestamp_ms
                    if timestamp_iso:
                        run["updatedAt"] = timestamp_iso
                    if timestamp_ms is not None:
                        run["updatedAtMs"] = timestamp_ms

        if role != "toolResult":
            continue

        tool_name = str(message.get("toolName") or message.get("name") or "").strip().lower()
        if tool_name not in COMMAND_MONITOR_TOOL_NAMES:
            continue

        raw_call_id = message.get("toolCallId") or message.get("id")
        call_id = str(raw_call_id).strip() if raw_call_id is not None else ""
        if not call_id:
            synthetic_counter += 1
            call_id = f"result-{index}-{synthetic_counter}"

        run = ensure_run(call_id, tool_name, index)
        preview = content_preview(message.get("content"))
        run["preview"] = preview
        run["status"] = infer_command_result_status(message, preview)
        if timestamp_iso:
            run["updatedAt"] = timestamp_iso
        if timestamp_ms is not None:
            run["updatedAtMs"] = timestamp_ms
        if run["status"] != "running":
            if timestamp_iso:
                run["finishedAt"] = timestamp_iso
            if run.get("startedAt") is None and timestamp_iso:
                run["startedAt"] = timestamp_iso
            if run.get("startedAtMs") is None and timestamp_ms is not None:
                run["startedAtMs"] = timestamp_ms

    runs: List[Dict[str, Any]] = []
    for call_id in creation_order:
        run = runs_by_call_id.get(call_id)
        if not run:
            continue
        runs.append(
            {
                "callId": run.get("callId"),
                "toolName": run.get("toolName"),
                "status": run.get("status") or "unknown",
                "command": run.get("command"),
                "preview": run.get("preview"),
                "startedAt": run.get("startedAt"),
                "finishedAt": run.get("finishedAt"),
                "updatedAt": run.get("updatedAt"),
                "_updatedAtMs": run.get("updatedAtMs"),
                "_startedAtMs": run.get("startedAtMs"),
                "_index": run.get("index"),
            }
        )

    runs.sort(
        key=lambda run: (
            int(run.get("_updatedAtMs") or run.get("_startedAtMs") or 0),
            int(run.get("_index") or 0),
        ),
        reverse=True,
    )

    compacted: List[Dict[str, Any]] = []
    for run in runs[:max_runs]:
        item = dict(run)
        item.pop("_updatedAtMs", None)
        item.pop("_startedAtMs", None)
        item.pop("_index", None)
        compacted.append(item)
    return compacted


async def fetch_gateway_sessions_with_fallback(limit: int) -> List[Dict[str, Any]]:
    last_error: Optional[HTTPException] = None
    attempts = [
        {"limit": limit, "messageLimit": 0},
        {"limit": limit},
        {},
    ]
    for args in attempts:
        try:
            response = await call_openclaw_tool("sessions_list", args, timeout_seconds=20.0)
            return parse_sessions_list_response(response)
        except HTTPException as exc:
            last_error = exc
            continue

    if last_error is not None:
        raise last_error
    return []


def tickets_by_session_key(session_keys: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    keys = [key.strip() for key in session_keys if key and key.strip()]
    if not keys:
        return {}

    placeholders = ",".join(["?"] * len(keys))
    query = (
        "SELECT id, title, status, assignee, agent_session_key "
        "FROM tickets "
        f"WHERE agent_session_key IN ({placeholders})"
    )
    mapping: Dict[str, List[Dict[str, Any]]] = {}
    with get_db() as conn:
        rows = conn.execute(query, keys).fetchall()
        for row in rows:
            key = str(row["agent_session_key"] or "").strip()
            if not key:
                continue
            mapping.setdefault(key, []).append(
                {
                    "id": int(row["id"]),
                    "title": str(row["title"] or ""),
                    "status": str(row["status"] or ""),
                    "assignee": str(row["assignee"] or ""),
                }
            )

    for key in mapping:
        mapping[key].sort(key=lambda item: item["id"], reverse=True)

    return mapping


async def is_session_live(session_key: str) -> Dict[str, Any]:
    key = session_key.strip()
    if not key:
        return {"attempted": False, "live": False, "reason": "Empty session key"}

    try:
        response = await call_openclaw_tool(
            "sessions_list",
            {"limit": 200, "messageLimit": 0},
            timeout_seconds=20.0,
        )
    except HTTPException as exc:
        return {"attempted": True, "live": False, "reason": str(exc.detail)}

    sessions = parse_sessions_list_response(response)
    if not sessions:
        return {"attempted": True, "live": False, "reason": "No sessions returned by gateway"}

    for session in sessions:
        candidate = str(
            session.get("sessionKey")
            or session.get("key")
            or session.get("id")
            or ""
        ).strip()
        if candidate != key:
            continue

        status = str(session.get("status") or session.get("state") or "").strip().lower()
        if status in {"", "running", "active", "idle", "queued", "started"}:
            return {"attempted": True, "live": True, "status": status or "unknown"}
        return {
            "attempted": True,
            "live": False,
            "reason": f"Session present but not live (status={status})",
            "status": status,
        }

    return {"attempted": True, "live": False, "reason": "Session key not found"}


def build_spawn_prompt(ticket: Dict[str, Any], status: str) -> str:
    status_instruction = (
        "Perform planning and analysis only, then move the ticket to Review when planning is complete."
        if status == "Plan"
        else "Implement the requested change, then move the ticket to Review when implementation is complete."
    )
    return (
        f"# Ticket #{ticket['id']}: {ticket['title']}\n\n"
        f"Description:\n{ticket.get('description') or '(none)'}\n\n"
        f"Priority: {ticket.get('priority', 'Medium')}\n"
        f"Assignee: {ticket.get('assignee', 'Unassigned')}\n"
        f"Current Status: {status}\n\n"
        f"You were assigned this ticket because it moved to {status}.\n"
        "Read the ticket and existing comments before starting, especially the latest comment.\n"
        f"{status_instruction}\n"
        "Report updates by posting comments to the Kanban API.\n"
        f"POST {API_BASE_URL}/api/tickets/{ticket['id']}/comments with JSON {{\"author\":\"{ticket.get('assignee','Agent')}\",\"content\":\"update\"}}\n"
        "Keep the response concise and actionable."
    )


async def spawn_agent_for_ticket(ticket: Dict[str, Any], status: str) -> Dict[str, Any]:
    assignee = (ticket.get("assignee") or "").strip()
    if not OPENCLAW_TOKEN:
        return {"attempted": False, "spawned": False, "reason": "OPENCLAW_TOKEN is not configured"}
    if not assignee or assignee == "Unassigned":
        return {"attempted": False, "spawned": False, "reason": "No assignee"}

    agent_id = await resolve_assignee_agent_id(assignee)

    if not agent_id:
        return {
            "attempted": False,
            "spawned": False,
            "reason": f"No configured gateway agent found for assignee '{assignee}'",
        }

    payload_args = {
        "agentId": agent_id,
        "task": build_spawn_prompt(ticket, status),
        "label": f"ticket-{ticket['id']}",
        "cleanup": "keep",
    }

    try:
        response = await call_openclaw_tool("sessions_spawn", payload_args, timeout_seconds=75.0)
    except HTTPException as exc:
        return {
            "attempted": True,
            "spawned": False,
            "reason": str(exc.detail),
        }

    result = response.get("result", {})
    details: Dict[str, Any] = {}
    parsed_content: Dict[str, Any] = {}

    if isinstance(result, dict):
        maybe_details = result.get("details")
        if isinstance(maybe_details, dict):
            details = maybe_details

        content = result.get("content")
        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict):
                text = first.get("text")
                if isinstance(text, str):
                    try:
                        parsed = json.loads(text)
                        if isinstance(parsed, dict):
                            parsed_content = parsed
                    except json.JSONDecodeError:
                        pass

    status = details.get("status") or parsed_content.get("status")
    error = details.get("error") or parsed_content.get("error")

    # OpenClaw may return ok=true even when details.status=error.
    if status == "error" or error:
        reason = str(error or "sessions_spawn returned status=error")
        return {
            "attempted": True,
            "spawned": False,
            "reason": reason,
            "status": status or "error",
        }

    session_key = (
        details.get("childSessionKey")
        or parsed_content.get("childSessionKey")
        or (result.get("childSessionKey") if isinstance(result, dict) else None)
    )
    run_id = (
        details.get("runId")
        or parsed_content.get("runId")
        or (result.get("runId") if isinstance(result, dict) else None)
    )

    if not session_key:
        return {
            "attempted": True,
            "spawned": False,
            "reason": "sessions_spawn returned no childSessionKey",
        }

    return {
        "attempted": True,
        "spawned": True,
        "session_key": session_key,
        "agent_id": agent_id,
        "run_id": run_id,
    }


async def ensure_agent_session(ticket: Dict[str, Any], status: str) -> Dict[str, Any]:
    existing_key = str(ticket.get("agent_session_key") or "").strip()
    if existing_key:
        live = await is_session_live(existing_key)
        if live.get("live"):
            return {
                "attempted": True,
                "spawned": False,
                "reused": True,
                "session_key": existing_key,
                "reason": "Reused existing live session",
            }

    spawn = await spawn_agent_for_ticket(ticket, status)
    if spawn.get("spawned"):
        spawn["reused"] = False
    return spawn


def build_comment_followup_prompt(ticket: Dict[str, Any], comment: Dict[str, Any]) -> str:
    return (
        f"Ticket #{ticket['id']} received a new comment.\n\n"
        f"Title: {ticket.get('title') or '(untitled)'}\n"
        f"Status: {ticket.get('status') or '(unknown)'}\n"
        f"Author: {comment.get('author') or 'Unknown'}\n\n"
        "New comment:\n"
        f"{comment.get('content') or '(empty)'}\n\n"
        "Read ticket details and latest comments before responding. "
        "Post a concise update comment if action is needed."
    )


async def notify_agent_on_comment(ticket: Dict[str, Any], comment: Dict[str, Any]) -> Dict[str, Any]:
    if not OPENCLAW_TOKEN:
        return {"attempted": False, "notified": False, "reason": "OPENCLAW_TOKEN is not configured"}

    status = str(ticket.get("status") or "")
    if status not in AUTOMATION_TRIGGER_STATUSES:
        return {"attempted": False, "notified": False, "reason": f"Status '{status}' does not trigger automation"}

    session_key = str(ticket.get("agent_session_key") or "").strip()
    if not session_key:
        return {"attempted": False, "notified": False, "reason": "No active agent session"}

    assignee = str(ticket.get("assignee") or "").strip().lower()
    author = str(comment.get("author") or "").strip().lower()
    if assignee and author and assignee == author:
        return {"attempted": False, "notified": False, "reason": "Comment authored by assignee"}

    prompt = build_comment_followup_prompt(ticket, comment)
    payload_args = {
        "sessionKey": session_key,
        "message": prompt,
        "timeoutSeconds": 90,
    }

    try:
        await call_openclaw_tool("sessions_send", payload_args, timeout_seconds=30.0)
        return {"attempted": True, "notified": True, "session_key": session_key}
    except HTTPException as first_exc:
        respawn = await spawn_agent_for_ticket(ticket, status)
        if not respawn.get("spawned"):
            return {
                "attempted": True,
                "notified": False,
                "reason": f"Notify failed: {first_exc.detail}; respawn failed: {respawn.get('reason', 'unknown')}",
                "session_key": session_key,
            }

        retry_key = str(respawn.get("session_key") or "").strip()
        retry_payload = {
            "sessionKey": retry_key,
            "message": prompt,
            "timeoutSeconds": 90,
        }
        try:
            await call_openclaw_tool("sessions_send", retry_payload, timeout_seconds=30.0)
            return {
                "attempted": True,
                "notified": True,
                "session_key": retry_key,
                "respawned": True,
                "previous_session_key": session_key,
            }
        except HTTPException as retry_exc:
            return {
                "attempted": True,
                "notified": False,
                "reason": f"Notify failed: {first_exc.detail}; retry after respawn failed: {retry_exc.detail}",
                "session_key": retry_key,
                "respawned": True,
                "previous_session_key": session_key,
            }


def validate_transition(current_status: str, target_status: str) -> None:
    if target_status not in STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(STATUSES)}")
    if target_status == current_status:
        return
    allowed = ALLOWED_TRANSITIONS.get(current_status, set())
    if target_status not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"invalid transition from '{current_status}' to '{target_status}'",
        )


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/")
def index() -> Any:
    index_file = FRONTEND_DIST_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {
        "ok": False,
        "detail": "frontend build not found. Run `npm run build` in frontend/.",
    }


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "kanban-backend", "db": str(DB_PATH)}


@app.get("/api/config")
async def get_config() -> Dict[str, Any]:
    assignee_options = fallback_assignee_options()
    try:
        directory = await get_cached_gateway_agents(force_refresh=False)
        gateway_options = assignee_options_from_agents(directory.get("agents", []))
        if len(gateway_options) > 1:
            assignee_options = gateway_options
    except HTTPException:
        pass

    return {
        "statuses": STATUSES,
        "priorities": PRIORITIES,
        "assignees": assignee_options,
    }


@app.get("/api/agents")
async def list_agents(force_refresh: bool = False) -> Dict[str, Any]:
    if not OPENCLAW_TOKEN:
        return {
            "ok": False,
            "agents": [],
            "cacheTtlSeconds": AGENT_CACHE_TTL_SECONDS,
            "cached": False,
            "stale": False,
            "detail": "OPENCLAW_TOKEN is not configured",
        }

    directory = await get_cached_gateway_agents(force_refresh=force_refresh)
    fetched_at = directory.get("fetched_at")
    expires_at = directory.get("expires_at")

    return {
        "ok": True,
        "agents": directory.get("agents", []),
        "cacheTtlSeconds": AGENT_CACHE_TTL_SECONDS,
        "cached": bool(directory.get("cached")),
        "stale": bool(directory.get("stale")),
        "fetchedAt": datetime.fromtimestamp(float(fetched_at), tz=timezone.utc).isoformat() if fetched_at else None,
        "expiresAt": datetime.fromtimestamp(float(expires_at), tz=timezone.utc).isoformat() if expires_at else None,
    }


@app.get("/api/gateway/health")
async def gateway_health() -> Dict[str, Any]:
    if not OPENCLAW_TOKEN:
        return {"ok": False, "gateway": "disabled", "detail": "OPENCLAW_TOKEN is not configured"}

    try:
        # Prefer agents_list because some gateways restrict sessions_* tools by policy.
        await call_openclaw_tool("agents_list", {}, timeout_seconds=10.0)
        return {"ok": True, "gateway": "reachable"}
    except HTTPException as agents_exc:
        try:
            # Backward compatibility for environments that may not expose agents_list.
            await call_openclaw_tool("sessions_list", {"limit": 1, "messageLimit": 0}, timeout_seconds=10.0)
            return {"ok": True, "gateway": "reachable"}
        except HTTPException as sessions_exc:
            return {
                "ok": False,
                "gateway": "unreachable",
                "detail": f"agents_list failed: {agents_exc.detail}; sessions_list failed: {sessions_exc.detail}",
            }


@app.get("/api/gateway/sessions/activity")
async def gateway_sessions_activity(session_limit: int = 24, history_limit: int = 160) -> Dict[str, Any]:
    if session_limit < 1 or session_limit > 200:
        raise HTTPException(status_code=400, detail="session_limit must be between 1 and 200")
    if history_limit < 1 or history_limit > 500:
        raise HTTPException(status_code=400, detail="history_limit must be between 1 and 500")

    generated_at = now_iso()
    if not OPENCLAW_TOKEN:
        return {
            "ok": False,
            "generatedAt": generated_at,
            "sessions": [],
            "detail": "OPENCLAW_TOKEN is not configured",
        }

    try:
        sessions = await fetch_gateway_sessions_with_fallback(limit=session_limit)
    except HTTPException as exc:
        return {
            "ok": False,
            "generatedAt": generated_at,
            "sessions": [],
            "detail": str(exc.detail),
        }

    agent_name_by_id: Dict[str, str] = {}
    try:
        directory = await get_cached_gateway_agents(force_refresh=False)
        for item in directory.get("agents", []):
            if not isinstance(item, dict):
                continue
            agent_id = str(item.get("id") or "").strip()
            if not agent_id:
                continue
            name = str(item.get("name") or "").strip()
            if name:
                agent_name_by_id[agent_id] = name
    except HTTPException:
        pass

    session_keys: List[str] = []
    for session in sessions:
        key = str(session.get("key") or session.get("sessionKey") or session.get("id") or "").strip()
        if key:
            session_keys.append(key)
    ticket_map = tickets_by_session_key(session_keys)

    semaphore = asyncio.Semaphore(6)

    async def build_session_activity(session: Dict[str, Any], index: int) -> Dict[str, Any]:
        key = str(session.get("key") or session.get("sessionKey") or session.get("id") or "").strip()
        status = str(session.get("status") or session.get("state") or "unknown").strip().lower() or "unknown"
        kind = str(session.get("kind") or "").strip() or None
        channel = str(session.get("channel") or session.get("lastChannel") or "").strip() or None
        display_name = str(session.get("displayName") or "").strip() or None
        model = str(session.get("model") or "").strip() or None

        delivery_context = session.get("deliveryContext")
        if channel is None and isinstance(delivery_context, dict):
            delivery_channel = delivery_context.get("channel")
            if isinstance(delivery_channel, str) and delivery_channel.strip():
                channel = delivery_channel.strip()

        updated_raw = session.get("updatedAt") or session.get("updated_at") or session.get("timestamp")
        updated_ts = normalize_gateway_timestamp(updated_raw)
        updated_at = updated_ts.get("iso")
        updated_at_ms = int(updated_ts.get("ms") or 0)

        agent_id = str(session.get("agentId") or "").strip() or infer_agent_id_from_session_key(key)
        agent_name = agent_name_by_id.get(agent_id) if agent_id else None

        commands: List[Dict[str, Any]] = []
        history_error: Optional[str] = None

        if key:
            async with semaphore:
                try:
                    history_response = await call_openclaw_tool(
                        "sessions_history",
                        {"sessionKey": key, "limit": history_limit, "includeTools": True},
                        timeout_seconds=30.0,
                    )
                    messages = parse_sessions_history_messages(history_response)
                    commands = extract_command_runs(messages)
                except HTTPException as exc:
                    history_error = str(exc.detail)

        running_count = sum(1 for item in commands if str(item.get("status")) == "running")
        error_count = sum(1 for item in commands if str(item.get("status")) == "error")
        last_command = commands[0] if commands else None

        last_command_at = str(last_command.get("updatedAt")) if isinstance(last_command, dict) else None
        last_command_status = str(last_command.get("status")) if isinstance(last_command, dict) else None
        last_command_preview = (
            str(last_command.get("preview"))[:220]
            if isinstance(last_command, dict) and isinstance(last_command.get("preview"), str)
            else None
        )

        return {
            "key": key,
            "status": status,
            "kind": kind,
            "channel": channel,
            "displayName": display_name,
            "model": model,
            "agentId": agent_id,
            "agentName": agent_name,
            "updatedAt": updated_at,
            "commandCount": len(commands),
            "runningCount": running_count,
            "errorCount": error_count,
            "lastCommandAt": last_command_at,
            "lastCommandStatus": last_command_status,
            "lastCommandPreview": last_command_preview,
            "historyError": history_error,
            "tickets": ticket_map.get(key, []),
            "commands": commands,
            "_updatedAtMs": updated_at_ms,
            "_index": index,
        }

    session_rows = await asyncio.gather(*[build_session_activity(session, idx) for idx, session in enumerate(sessions)])
    session_rows.sort(key=lambda row: (int(row.get("_updatedAtMs") or 0), -int(row.get("_index") or 0)), reverse=True)
    for row in session_rows:
        row.pop("_updatedAtMs", None)
        row.pop("_index", None)

    return {
        "ok": True,
        "generatedAt": generated_at,
        "sessions": session_rows,
    }


@app.get("/api/activity")
def list_activity(
    limit: int = 250,
    offset: int = 0,
    ticket_id: Optional[int] = None,
    event_type: Optional[str] = None,
    include_archived: bool = False,
) -> List[Dict[str, Any]]:
    if limit < 1 or limit > 1000:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 1000")
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be >= 0")

    with get_db() as conn:
        query = (
            "SELECT "
            "e.id, e.ticket_id, e.event_type, e.actor, e.details, e.created_at, "
            "t.title AS ticket_title, t.status AS ticket_status, t.assignee AS ticket_assignee, "
            "t.priority AS ticket_priority, t.archived_at AS ticket_archived_at "
            "FROM ticket_events e "
            "JOIN tickets t ON t.id = e.ticket_id "
            "WHERE 1=1"
        )
        params: List[Any] = []

        if not include_archived:
            query += " AND t.archived_at IS NULL"
        if ticket_id is not None:
            query += " AND e.ticket_id = ?"
            params.append(ticket_id)
        if event_type:
            query += " AND e.event_type = ?"
            params.append(event_type)

        query += " ORDER BY e.created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        rows = conn.execute(query, params).fetchall()
        return [row_to_dict(r) for r in rows]


@app.get("/api/workspace/list")
def list_workspace(path: str = "", include_hidden: bool = False) -> Dict[str, Any]:
    if not WORKSPACE_ROOT.exists() or not WORKSPACE_ROOT.is_dir():
        raise HTTPException(status_code=500, detail=f"Workspace root is unavailable: {WORKSPACE_ROOT}")

    directory, resolved_root = resolve_workspace_path_for_read(path, expected_kind="dir")

    entries: List[Dict[str, Any]] = []
    try:
        for child in directory.iterdir():
            name = child.name
            if not include_hidden and name.startswith("."):
                continue
            if child.is_dir() and name in WORKSPACE_SKIP_DIRS:
                continue
            entries.append(workspace_entry(child, root=resolved_root))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=f"Permission denied: {exc}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to list directory: {exc}") from exc

    entries.sort(key=lambda item: (item["type"] != "dir", item["name"].lower()))
    rel_path = workspace_relative(directory, root=resolved_root) if directory != resolved_root else ""

    return {
        "root": str(resolved_root),
        "path": rel_path,
        "entries": entries,
    }


@app.get("/api/workspace/file")
def read_workspace_file(path: str) -> Dict[str, Any]:
    if not WORKSPACE_ROOT.exists() or not WORKSPACE_ROOT.is_dir():
        raise HTTPException(status_code=500, detail=f"Workspace root is unavailable: {WORKSPACE_ROOT}")

    file_path, resolved_root = resolve_workspace_path_for_read(path, expected_kind="file")

    stats = file_path.stat()
    if stats.st_size > WORKSPACE_MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large ({stats.st_size} bytes). Max is {WORKSPACE_MAX_FILE_BYTES} bytes",
        )

    is_image = is_image_file(file_path)
    content = ""
    if not is_image:
        try:
            content = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=415, detail="file is not UTF-8 text") from exc
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=f"Permission denied: {exc}") from exc
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to read file: {exc}") from exc

    return {
        "root": str(resolved_root),
        "path": workspace_relative(file_path, root=resolved_root),
        "name": file_path.name,
        "content": content,
        "isMarkdown": is_markdown_file(file_path),
        "isImage": is_image,
        "sizeBytes": stats.st_size,
        "updatedAt": datetime.fromtimestamp(stats.st_mtime, tz=timezone.utc).isoformat(),
    }


@app.get("/api/workspace/content")
def read_workspace_content(path: str) -> FileResponse:
    if not WORKSPACE_ROOT.exists() or not WORKSPACE_ROOT.is_dir():
        raise HTTPException(status_code=500, detail=f"Workspace root is unavailable: {WORKSPACE_ROOT}")

    file_path, _ = resolve_workspace_path_for_read(path, expected_kind="file")
    if not is_image_file(file_path):
        raise HTTPException(status_code=415, detail="workspace content preview only supports image files")

    return FileResponse(path=file_path)


def write_workspace_file_content(file_path: Path, content: str) -> None:
    parent = file_path.parent
    temp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(parent),
            prefix=f".{file_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_file.write(content)
            temp_path = Path(temp_file.name)
        os.replace(temp_path, file_path)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=f"Permission denied: {exc}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {exc}") from exc
    finally:
        if temp_path is not None and temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass


@app.post("/api/workspace/file")
def create_workspace_file(create: WorkspaceFileCreate) -> Dict[str, Any]:
    if not WORKSPACE_ROOT.exists() or not WORKSPACE_ROOT.is_dir():
        raise HTTPException(status_code=500, detail=f"Workspace root is unavailable: {WORKSPACE_ROOT}")

    file_path = resolve_workspace_path(create.path)
    if file_path.exists():
        raise HTTPException(status_code=409, detail="file already exists")

    parent = file_path.parent
    if not parent.exists() or not parent.is_dir():
        raise HTTPException(status_code=400, detail="parent directory does not exist")

    payload_size = len(create.content.encode("utf-8"))
    if payload_size > WORKSPACE_MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"content too large ({payload_size} bytes). Max is {WORKSPACE_MAX_FILE_BYTES} bytes",
        )

    write_workspace_file_content(file_path, create.content)

    stats = file_path.stat()
    return {
        "ok": True,
        "root": str(WORKSPACE_ROOT),
        "path": workspace_relative(file_path),
        "name": file_path.name,
        "isMarkdown": is_markdown_file(file_path),
        "isImage": is_image_file(file_path),
        "sizeBytes": stats.st_size,
        "updatedAt": datetime.fromtimestamp(stats.st_mtime, tz=timezone.utc).isoformat(),
    }


@app.put("/api/workspace/file")
def update_workspace_file(update: WorkspaceFileUpdate) -> Dict[str, Any]:
    if not WORKSPACE_ROOT.exists() or not WORKSPACE_ROOT.is_dir():
        raise HTTPException(status_code=500, detail=f"Workspace root is unavailable: {WORKSPACE_ROOT}")

    file_path = resolve_workspace_path(update.path)
    if file_path.exists() and not file_path.is_file():
        raise HTTPException(status_code=400, detail="path exists and is not a file")

    parent = file_path.parent
    if not parent.exists() or not parent.is_dir():
        raise HTTPException(status_code=400, detail="parent directory does not exist")

    payload_size = len(update.content.encode("utf-8"))
    if payload_size > WORKSPACE_MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"content too large ({payload_size} bytes). Max is {WORKSPACE_MAX_FILE_BYTES} bytes",
        )

    write_workspace_file_content(file_path, update.content)

    stats = file_path.stat()
    return {
        "ok": True,
        "root": str(WORKSPACE_ROOT),
        "path": workspace_relative(file_path),
        "name": file_path.name,
        "isMarkdown": is_markdown_file(file_path),
        "isImage": is_image_file(file_path),
        "sizeBytes": stats.st_size,
        "updatedAt": datetime.fromtimestamp(stats.st_mtime, tz=timezone.utc).isoformat(),
    }


@app.delete("/api/workspace/file")
def delete_workspace_file(path: str) -> Dict[str, Any]:
    if not WORKSPACE_ROOT.exists() or not WORKSPACE_ROOT.is_dir():
        raise HTTPException(status_code=500, detail=f"Workspace root is unavailable: {WORKSPACE_ROOT}")

    target_path = resolve_workspace_path(path)
    if target_path == WORKSPACE_ROOT:
        raise HTTPException(status_code=400, detail="cannot delete workspace root")
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="path not found")

    try:
        if target_path.is_file() or target_path.is_symlink():
            target_path.unlink()
        elif target_path.is_dir():
            shutil.rmtree(target_path)
        else:
            raise HTTPException(status_code=400, detail="path is not a file or directory")
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=f"Permission denied: {exc}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete path: {exc}") from exc

    parent_path = workspace_relative(target_path.parent) if target_path.parent != WORKSPACE_ROOT else ""
    return {
        "ok": True,
        "path": workspace_relative(target_path),
        "name": target_path.name,
        "parentPath": parent_path,
    }


@app.get("/api/tickets")
def list_tickets(
    status: Optional[str] = None,
    assignee: Optional[str] = None,
    archived: bool = False,
) -> List[Dict[str, Any]]:
    with get_db() as conn:
        query = "SELECT * FROM tickets WHERE 1=1"
        params: List[Any] = []

        if archived:
            query += " AND archived_at IS NOT NULL"
        else:
            query += " AND archived_at IS NULL"

        if status:
            query += " AND status = ?"
            params.append(status)
        if assignee:
            query += " AND assignee = ?"
            params.append(assignee)

        if archived:
            query += " ORDER BY archived_at DESC, updated_at DESC"
        else:
            query += (
                " ORDER BY "
                "CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END, "
                "updated_at DESC"
            )

        rows = conn.execute(query, params).fetchall()
        return [row_to_dict(r) for r in rows]


@app.get("/api/tickets/{ticket_id}")
def get_ticket(ticket_id: int) -> Dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ticket not found")
        return row_to_dict(row)


@app.get("/api/tickets/{ticket_id}/docs")
def get_ticket_docs(ticket_id: int) -> Dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT id, title FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ticket not found")
        ticket = row_to_dict(row)

    folder = find_task_docs_dir(ticket_id, preferred_title=ticket["title"])
    expected_folder = default_task_docs_dir(ticket_id, ticket["title"])
    files: List[Dict[str, Any]] = []
    exists = bool(folder and folder.exists() and folder.is_dir())

    if exists and folder is not None:
        try:
            files = list_task_docs_files(folder)
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=f"Task docs path is outside workspace root: {exc}") from exc
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to list task docs: {exc}") from exc

    folder_for_response = folder if folder is not None else expected_folder
    return {
        "ticketId": ticket_id,
        "folderPath": workspace_relative_or_string(folder_for_response),
        "exists": exists,
        "files": files,
    }


@app.post("/api/tickets")
async def create_ticket(ticket: TicketCreate) -> Dict[str, Any]:
    ts = now_iso()

    with get_db() as conn:
        cursor = conn.execute(
            """
            INSERT INTO tickets (title, description, status, assignee, priority, archived_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (ticket.title, ticket.description, "Todo", ticket.assignee, ticket.priority, None, ts, ts),
        )
        ticket_id = cursor.lastrowid

        event = create_event(conn, ticket_id, "ticket_created", "User", f"Created ticket: {ticket.title}")
        conn.commit()

        row = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        created = row_to_dict(row)

    await manager.broadcast({"type": "ticket_created", "ticket": created})
    await manager.broadcast({"type": "ticket_event", "event": event})
    return created


@app.patch("/api/tickets/{ticket_id}")
async def update_ticket(ticket_id: int, update: TicketUpdate) -> Dict[str, Any]:
    docs_move_event: Optional[Dict[str, Any]] = None
    with get_db() as conn:
        row = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ticket not found")

        current = row_to_dict(row)
        fields: List[str] = []
        params: List[Any] = []
        change_summary: List[str] = []
        docs_move_details: Optional[Dict[str, str]] = None

        new_title = update.title if update.title is not None else current["title"]
        title_changed = update.title is not None and update.title != current["title"]

        if title_changed:
            source_dir = find_task_docs_dir(ticket_id, preferred_title=current["title"])

            if source_dir and source_dir.is_dir():
                target_dir = expected_task_docs_dir_for_root(source_dir.parent, ticket_id, new_title)
                if source_dir != target_dir:
                    if target_dir.exists():
                        raise HTTPException(
                            status_code=409,
                            detail=f"Target docs folder already exists: {workspace_relative_or_string(target_dir)}",
                        )
                    target_dir.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        source_dir.rename(target_dir)
                    except OSError as exc:
                        raise HTTPException(status_code=500, detail=f"Failed to move task docs folder: {exc}") from exc
                    docs_move_details = {
                        "from": workspace_relative_or_string(source_dir),
                        "to": workspace_relative_or_string(target_dir),
                    }

        for name in ["title", "description", "assignee", "priority"]:
            new_value = getattr(update, name)
            if new_value is not None and new_value != current[name]:
                fields.append(f"{name} = ?")
                params.append(new_value)
                change_summary.append(f"{name}: {current[name]} -> {new_value}")

        if not fields:
            return current

        fields.append("updated_at = ?")
        params.append(now_iso())
        params.append(ticket_id)

        conn.execute(f"UPDATE tickets SET {', '.join(fields)} WHERE id = ?", params)
        event = create_event(conn, ticket_id, "ticket_updated", "User", "; ".join(change_summary))
        if docs_move_details:
            docs_move_event = create_event(
                conn,
                ticket_id,
                "ticket_docs_moved",
                "User",
                f"{docs_move_details['from']} -> {docs_move_details['to']}",
            )
        conn.commit()

        updated = row_to_dict(conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone())

    await manager.broadcast({"type": "ticket_updated", "ticket": updated})
    await manager.broadcast({"type": "ticket_event", "event": event})
    if docs_move_event is not None:
        await manager.broadcast({"type": "ticket_event", "event": docs_move_event})
    return updated


@app.post("/api/tickets/{ticket_id}/archive")
async def archive_ticket(ticket_id: int, actor: str = "User") -> Dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ticket not found")

        current = row_to_dict(row)
        if current.get("archived_at"):
            return current

        ts = now_iso()
        conn.execute(
            "UPDATE tickets SET archived_at = ?, updated_at = ? WHERE id = ?",
            (ts, ts, ticket_id),
        )
        event = create_event(conn, ticket_id, "ticket_archived", actor, f"Archived from {current['status']}")
        conn.commit()

        archived_ticket = row_to_dict(conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone())

    await manager.broadcast({"type": "ticket_archived", "ticket": archived_ticket})
    await manager.broadcast({"type": "ticket_updated", "ticket": archived_ticket})
    await manager.broadcast({"type": "ticket_event", "event": event})
    return archived_ticket


@app.post("/api/tickets/{ticket_id}/move")
async def move_ticket(ticket_id: int, status: str, actor: str = "User") -> Dict[str, Any]:
    warnings: List[str] = []
    comments_to_broadcast: List[Dict[str, Any]] = []
    events_to_broadcast: List[Dict[str, Any]] = []
    pickup: Dict[str, Any] = {"attempted": False, "spawned": False}

    with get_db() as conn:
        row = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ticket not found")

        current = row_to_dict(row)
        if current.get("archived_at"):
            raise HTTPException(status_code=400, detail="cannot move archived ticket")
        old_status = current["status"]
        validate_transition(old_status, status)

        if old_status != status:
            conn.execute(
                "UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?",
                (status, now_iso(), ticket_id),
            )

        move_event = create_event(conn, ticket_id, "ticket_moved", actor, f"{old_status} -> {status}")

        updated = row_to_dict(conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone())

        if old_status != status and status in AUTOMATION_TRIGGER_STATUSES:
            session_result = await ensure_agent_session(updated, status)
            pickup = session_result
            if session_result.get("reused"):
                reuse_event = create_event(
                    conn,
                    ticket_id,
                    "agent_reused",
                    actor,
                    f"Reused existing session {session_result.get('session_key')} on status {status}",
                )
                events_to_broadcast.append(reuse_event)
            elif session_result.get("spawned"):
                session_key = session_result.get("session_key")
                conn.execute(
                    "UPDATE tickets SET agent_session_key = ?, updated_at = ? WHERE id = ?",
                    (session_key, now_iso(), ticket_id),
                )
                spawn_event = create_event(
                    conn,
                    ticket_id,
                    "agent_spawned",
                    actor,
                    f"Assignee {updated['assignee']} mapped to {session_result.get('agent_id')} session={session_key} on status {status}",
                )
                comment = create_comment(
                    conn,
                    ticket_id,
                    "System",
                    f"Agent pickup started for **{updated['assignee']}** on **{status}**. Session: `{session_key}`",
                )
                comments_to_broadcast.append(comment)
                events_to_broadcast.append(spawn_event)
            else:
                reason = session_result.get("reason", "unknown")
                warnings.append(reason)
                failure_event = create_event(conn, ticket_id, "agent_spawn_failed", actor, reason)
                comment = create_comment(conn, ticket_id, "System", f"Agent pickup failed: {reason}")
                comments_to_broadcast.append(comment)
                events_to_broadcast.append(failure_event)

        if (
            old_status != status
            and old_status in AUTOMATION_TRIGGER_STATUSES
            and status not in AUTOMATION_TRIGGER_STATUSES
            and str(updated.get("agent_session_key") or "").strip()
        ):
            previous_session_key = str(updated.get("agent_session_key") or "").strip()
            conn.execute(
                "UPDATE tickets SET agent_session_key = NULL, updated_at = ? WHERE id = ?",
                (now_iso(), ticket_id),
            )
            deactivate_event = create_event(
                conn,
                ticket_id,
                "agent_session_deactivated",
                actor,
                f"Cleared active routing session {previous_session_key} after move {old_status} -> {status}",
            )
            events_to_broadcast.append(deactivate_event)

        conn.commit()
        final_ticket = row_to_dict(conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone())

    await manager.broadcast({
        "type": "ticket_moved",
        "ticket": final_ticket,
        "from": old_status,
        "to": status,
    })
    await manager.broadcast({"type": "ticket_updated", "ticket": final_ticket})
    await manager.broadcast({"type": "ticket_event", "event": move_event})
    for event in events_to_broadcast:
        await manager.broadcast({"type": "ticket_event", "event": event})

    for comment in comments_to_broadcast:
        await manager.broadcast({"type": "comment_added", "ticket_id": ticket_id, "comment": comment})

    return {
        "ok": True,
        "ticket": final_ticket,
        "from": old_status,
        "to": status,
        "pickup": pickup,
        "warnings": warnings,
    }


@app.get("/api/tickets/{ticket_id}/comments")
def get_ticket_comments(ticket_id: int) -> List[Dict[str, Any]]:
    with get_db() as conn:
        row = conn.execute("SELECT id FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ticket not found")

        rows = conn.execute(
            "SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC",
            (ticket_id,),
        ).fetchall()
        return [row_to_dict(r) for r in rows]


@app.post("/api/tickets/{ticket_id}/comments")
async def add_ticket_comment(ticket_id: int, comment: CommentCreate) -> Dict[str, Any]:
    current_ticket: Optional[Dict[str, Any]] = None
    with get_db() as conn:
        row = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ticket not found")

        current_ticket = row_to_dict(row)
        created = create_comment(conn, ticket_id, comment.author, comment.content)
        event = create_event(conn, ticket_id, "comment_added", comment.author, comment.content[:300])
        conn.commit()

    followup_event: Optional[Dict[str, Any]] = None
    respawn_event: Optional[Dict[str, Any]] = None
    if current_ticket is not None:
        notify_result = await notify_agent_on_comment(current_ticket, created)
        if notify_result.get("attempted"):
            with get_db() as conn:
                if notify_result.get("respawned") and notify_result.get("session_key"):
                    conn.execute(
                        "UPDATE tickets SET agent_session_key = ?, updated_at = ? WHERE id = ?",
                        (notify_result.get("session_key"), now_iso(), ticket_id),
                    )
                    respawn_event = create_event(
                        conn,
                        ticket_id,
                        "agent_respawned_after_notify_failure",
                        "System",
                        f"Replaced session {notify_result.get('previous_session_key')} with {notify_result.get('session_key')}",
                    )

                if notify_result.get("notified"):
                    followup_event = create_event(
                        conn,
                        ticket_id,
                        "agent_notified",
                        "System",
                        f"Forwarded comment to session {notify_result.get('session_key')}",
                    )
                else:
                    followup_event = create_event(
                        conn,
                        ticket_id,
                        "agent_notify_failed",
                        "System",
                        str(notify_result.get("reason") or "Unknown notification failure"),
                    )
                conn.commit()

    await manager.broadcast({"type": "comment_added", "ticket_id": ticket_id, "comment": created})
    await manager.broadcast({"type": "ticket_event", "event": event})
    if respawn_event is not None:
        await manager.broadcast({"type": "ticket_event", "event": respawn_event})
    if followup_event is not None:
        await manager.broadcast({"type": "ticket_event", "event": followup_event})
    return created


@app.get("/api/tickets/{ticket_id}/events")
def get_ticket_events(ticket_id: int) -> List[Dict[str, Any]]:
    with get_db() as conn:
        row = conn.execute("SELECT id FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ticket not found")

        rows = conn.execute(
            "SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at DESC",
            (ticket_id,),
        ).fetchall()
        return [row_to_dict(r) for r in rows]


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.main:app", host="0.0.0.0", port=PORT, reload=True)
