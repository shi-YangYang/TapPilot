#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
exec codex "$(cat "$root/examples/settings-battery-prompt.txt")"
