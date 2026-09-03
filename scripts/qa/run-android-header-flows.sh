#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner's script step. That step
# executes each line with a fresh /bin/sh, so the workflow calls this file with
# bash explicitly and all logic lives here.
#
# Required env: APK_PATH, FLOWS_DIR, OUT_DIR
set -euo pipefail

: "${APK_PATH:?APK_PATH is required}"
: "${FLOWS_DIR:?FLOWS_DIR is required}"
: "${OUT_DIR:?OUT_DIR is required}"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

echo "::group::settle the emulator"
# The runner only waits for sys.boot_completed, which fires long before the
# launcher settles; a cold-booted google_apis image then throws a
# "Pixel Launcher isn't responding" ANR over the first app launch and Android
# reports only the modal window to UiAutomator. Stop new error dialogs first
# (ActivityTaskManagerService observes this setting live), then wait for the
# package service and for the launcher to hold focus.
adb shell settings put global hide_error_dialogs 1
# The AVD has a hardware keyboard (enable-hw-keyboard in the workflow); this
# keeps the soft keyboard from appearing on top of it. Maestro's inputText
# injects key events rather than typing through the IME, so text entry
# still works and the keyboard never covers the sheet's Connect button.
adb shell settings put secure show_ime_with_hard_keyboard 0
for i in $(seq 1 60); do
  if adb shell service list 2>/dev/null | grep -q '\bpackage\b'; then echo "package service up after ${i}s"; break; fi
  sleep 1
done
adb shell input keyevent 3
for i in $(seq 1 90); do
  focus="$(adb shell dumpsys window 2>/dev/null | grep -i mCurrentFocus || true)"
  case "$focus" in
    *"Not Responding"*|*"isn't responding"*|*"anr"*)
      echo "dismissing ANR dialog: $focus"
      adb shell input keyevent 4
      ;;
    *[Ll]auncher*)
      echo "launcher focused after ${i}s: $focus"
      break
      ;;
  esac
  sleep 1
done
echo "::endgroup::"

echo "::group::install apk"
adb install -r "$APK_PATH"
adb shell pm list packages | grep -F sh.paseo
echo "::endgroup::"

# Each flow starts with launchApp clearState, so a rerun is a clean retry.
# The bottom sheet's open animation occasionally stalls on this emulator
# (Reanimated, unrelated to the feature); a relaunch is the only safe reset.
run_flow() {
  local name="$1"
  local attempt
  for attempt in 1 2 3; do
    echo "::group::maestro flow: $name (attempt $attempt)"
    if maestro test --debug-output "$OUT_DIR/maestro-debug-$name-$attempt" "$FLOWS_DIR/$name.yaml"; then
      echo "::endgroup::"
      return 0
    fi
    echo "flow $name failed on attempt $attempt; capturing screen and logcat tail"
    adb exec-out screencap -p > "$OUT_DIR/failure-$name-$attempt.png" || true
    adb logcat -d -t 400 > "$OUT_DIR/logcat-$name-$attempt.txt" || true
    adb shell am force-stop sh.paseo || true
    echo "::endgroup::"
  done
  return 1
}

status=0
run_flow direct-headers-missing || status=1
run_flow direct-headers-gate || status=1

echo "artifacts in $OUT_DIR:"
ls -la "$OUT_DIR"
exit "$status"
