#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
node_bin="$(command -v node)"
adb_bin="${ADB_PATH:-$(command -v adb)}"
serial="${1:-${TAPPILOT_SERIAL:-}}"
approval_mode="${TAPPILOT_APPROVAL_MODE:-manual}"
case "$approval_mode" in
  manual) ;;
  trusted)
    if [[ -z "${serial//[[:space:]]/}" ]]; then
      printf 'Trusted authorization requires a specific USB device serial.\n' >&2
      exit 2
    fi
    ;;
  *) printf 'TAPPILOT_APPROVAL_MODE must be manual or trusted.\n' >&2; exit 2 ;;
esac
if [[ ! -f "$root/server/dist/index.js" ]]; then
  printf 'Build the server first: cd server && npm ci && npm run build\n' >&2
  exit 2
fi
args=(mcp add tappilot --env "ADB_PATH=$adb_bin" --env "TAPPILOT_APPROVAL_MODE=$approval_mode")
if [[ -n "$serial" ]]; then args+=(--env "TAPPILOT_SERIAL=$serial"); fi
codex "${args[@]}" -- "$node_bin" "$root/server/dist/index.js"
