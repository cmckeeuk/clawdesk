#!/bin/bash

load_root_env() {
  local root_dir="$1"
  local env_file="$root_dir/.env"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

url_host() {
  local url="${1:-}"
  if [[ "$url" =~ ^https?://([^/:]+) ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
    return 0
  fi
  printf ""
}

url_port() {
  local url="${1:-}"
  if [[ "$url" =~ :([0-9]+)(/|$) ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$url" =~ ^https:// ]]; then
    printf "443"
    return 0
  fi
  if [[ "$url" =~ ^http:// ]]; then
    printf "80"
    return 0
  fi
  printf ""
}
