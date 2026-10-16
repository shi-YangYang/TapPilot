#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
adb_bin="${ADB_PATH:-adb}"
serial="${1:-${TAPPILOT_SERIAL:-}}"
if [[ -z "$serial" ]]; then
  printf 'Usage: scripts/install.sh <USB device serial from adb devices -l>\n' >&2
  exit 2
fi
if [[ "$serial" == -* || "$serial" == *:* ]]; then
  printf 'Use a USB device serial, not a network address or option.\n' >&2
  exit 2
fi
apk="$root/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$apk" ]]; then
  printf 'Build the APK first: cd android && ./gradlew assembleDebug\n' >&2
  exit 2
fi
"$adb_bin" -s "$serial" get-state
"$adb_bin" -s "$serial" install -r "$apk"
"$adb_bin" -s "$serial" shell am start -n dev.tappilot.agent/.MainActivity
printf '\nRead the disclosure in TapPilot and manually enable its accessibility service.\n'
