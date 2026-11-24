#!/usr/bin/env bash
# Build the Habitat Android APK reproducibly and print its SHA-256.
#
#   ./scripts/build-android-apk.sh debug      # always installable (debug key)
#   ./scripts/build-android-apk.sh release    # requires owner signing variables
#
# Required for release (never committed):
#   HABITAT_KEYSTORE_FILE      absolute path to the owner .jks
#   HABITAT_KEYSTORE_PASSWORD
#   HABITAT_KEY_ALIAS
#   HABITAT_KEY_PASSWORD
set -euo pipefail

MODE="${1:-debug}"
case "$MODE" in
  debug) TASK=":app:assembleDebug" ;;
  release) TASK=":app:assembleRelease" ;;
  *) echo "usage: $0 [debug|release]" >&2; exit 64 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "BUILD BLOCKED: $*" >&2; exit 1; }

command -v java >/dev/null 2>&1 || fail "no JDK. Install Temurin 17 and set JAVA_HOME."
command -v gradle >/dev/null 2>&1 || fail "no Gradle. Install Gradle 8.7+ (the repo has no wrapper jar)."

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
[ -n "$SDK" ] || fail "set ANDROID_SDK_ROOT (or ANDROID_HOME) to an Android SDK with platform 35."
[ -d "$SDK/platforms/android-35" ] || fail "Android platform 35 is missing from $SDK."
[ -d "$SDK/build-tools/34.0.0" ] || fail "build-tools 34.0.0 is missing from $SDK."

if [ "$MODE" = "release" ]; then
  for name in HABITAT_KEYSTORE_FILE HABITAT_KEYSTORE_PASSWORD HABITAT_KEY_ALIAS HABITAT_KEY_PASSWORD; do
    [ -n "${!name:-}" ] || fail "$name is not set; refusing to produce an unsigned release APK."
  done
  [ -f "$HABITAT_KEYSTORE_FILE" ] || fail "keystore file not found: $HABITAT_KEYSTORE_FILE"
fi

echo "== Habitat Android build =="
echo "mode:    $MODE"
echo "java:    $(java -version 2>&1 | head -1)"
echo "gradle:  $(gradle --version 2>/dev/null | awk '/^Gradle/{print $2}')"
echo "sdk:     $SDK"

gradle "$TASK" --no-daemon --console=plain

APK_DIR="app/build/outputs/apk/$MODE"
APK="$(find "$APK_DIR" -maxdepth 1 -name '*.apk' -print -quit 2>/dev/null || true)"
[ -n "$APK" ] || fail "build finished but no APK was produced in $APK_DIR"

mkdir -p dist
OUT="dist/habitat-$(sed -n 's/.*versionName = "\([^"]*\)".*/\1/p' app/build.gradle.kts)-$MODE.apk"
cp "$APK" "$OUT"
HASH="$(sha256sum "$OUT" | awk '{print $1}')"
echo "APK:     $OUT"
echo "SHA-256: $HASH"
echo "$HASH  $(basename "$OUT")" > "$OUT.sha256"

if [ "$MODE" = "release" ]; then
  echo "Next: verify the signer before installing:"
  echo "  $SDK/build-tools/34.0.0/apksigner verify --print-certs '$OUT'"
fi
