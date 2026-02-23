#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

exec ./.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8080
