#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=scripts/start-common.sh
source "$ROOT_DIR/scripts/start-common.sh"
load_root_env "$ROOT_DIR"

BACKEND_HOST="$(url_host "${VITE_API_BASE_URL:-}")"
BACKEND_PORT="$(url_port "${VITE_API_BASE_URL:-}")"

exec ./.venv/bin/python -m uvicorn backend.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT"
