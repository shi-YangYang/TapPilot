#!/usr/bin/env bash
set -euo pipefail
printf 'TapPilot development environment\n'
for tool in node npm java adb codex; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '%s: %s\n' "$tool" "$(command -v "$tool")"
  else
    printf '%s: MISSING\n' "$tool"
  fi
done
if command -v node >/dev/null 2>&1; then node --version; fi
if command -v java >/dev/null 2>&1; then java -version; fi
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
printf 'Android SDK: %s\n' "$sdk"
if [[ -d "$sdk/platforms" ]]; then ls "$sdk/platforms"; fi
if command -v adb >/dev/null 2>&1; then adb devices -l; fi
printf '\nUse an authorized USB device. No devices means device validation cannot run yet.\n'
