#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/start-common.sh
source "$ROOT_DIR/scripts/start-common.sh"
load_root_env "$ROOT_DIR"

FRONTEND_HOST="$(url_host "${FRONTEND_URL:-}")"
FRONTEND_PORT="$(url_port "${FRONTEND_URL:-}")"

cd "$ROOT_DIR/frontend"
exec npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
