#!/usr/bin/env bash
# Compare the certificate of the Bridge installed on the phone with an APK's certificate.
#
# Read-only: it runs `adb get-state`, `adb shell dumpsys package` and `adb shell pm path`. It installs
# nothing, uninstalls nothing, and cannot change app data. Run it before considering any upgrade.
#
# Usage: scripts/verify-phone-signing.sh [path/to/app-debug.apk]

set -euo pipefail
PKG="com.habitat.axbridge"
APK="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb is not installed on this machine. Install platform-tools, connect the phone, then re-run." >&2
  exit 2
fi
if ! adb get-state >/dev/null 2>&1; then
  echo "No device in 'device' state. Check the USB cable and the on-phone authorisation prompt." >&2
  exit 2
fi

echo "package: $PKG"
echo "installed path: $(adb shell pm path "$PKG" 2>/dev/null | tr -d '\r' || echo 'not installed')"
echo "installed versionName: $(adb shell dumpsys package "$PKG" 2>/dev/null | sed -n 's/.*versionName=\([^ ]*\).*/\1/p' | head -1 | tr -d '\r' || echo unknown)"

echo
echo "--- installed signing certificate (as reported by the device) ---"
if ! adb shell dumpsys package "$PKG" 2>/dev/null | tr -d '\r' | sed -n 's/.*signatures=.*\[\([0-9a-f, ]*\)\].*/hex: \1/p' | head -1 | grep -q 'hex:'; then
  adb shell dumpsys package "$PKG" 2>/dev/null | tr -d '\r' | grep -m1 'signatures' || echo "(the device did not print a signatures line)"
fi

echo
if [ -n "$APK" ]; then
  echo "--- APK certificate fingerprint ---"
  node "$HERE/apk-cert-fingerprint.mjs" "$APK"
  echo "(this build is signed by the repository debug identity)"
  echo "repository expected: $(tr -d '[:space:]' < "$HERE/../EXPECTED_DEBUG_CERT_SHA256" 2>/dev/null || echo unavailable)"
else
  echo "No APK given; compare the device line above with EXPECTED_DEBUG_CERT_SHA256 if the installed build came from this repository."
fi

echo
echo "If the two sides differ, do NOT install over the app. See docs/ANDROID_SIGNING_COMPATIBILITY.md."
