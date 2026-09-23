#!/usr/bin/env bash
# Runs inside android-emulator-runner once the emulator has booted: installs
# the APK, connects the app to the E2E daemon, and runs the Android suites
# from the built source. Every suite runs even after an earlier one fails, so
# one run reports every broken flow; the exit status is non-zero if any failed.
#
# Needs: SRC_DIR, APK_PATH, APP_ID, DAEMON_PORT, SERVER_ID, WORKSPACE_ID,
# WORKSPACE_DIR, ARTIFACTS_DIR.
set -uo pipefail

: "${SRC_DIR:?}" "${APK_PATH:?}" "${APP_ID:?}" "${DAEMON_PORT:?}" "${SERVER_ID:?}"
: "${WORKSPACE_ID:?}" "${WORKSPACE_DIR:?}" "${ARTIFACTS_DIR:?}"
mkdir -p "${ARTIFACTS_DIR}"
failed=()
logcat_pid=0

finish() {
  adb exec-out screencap -p >"${ARTIFACTS_DIR}/final-screen.png" 2>/dev/null || true
  if [[ "${logcat_pid}" -gt 0 ]]; then
    kill "${logcat_pid}" 2>/dev/null || true
  fi
}
trap finish EXIT

# sys.boot_completed flips before the input and package services answer, and
# the first `input`/`am` calls after boot are the usual source of flakes.
wait_for_device() {
  adb wait-for-device
  for _ in $(seq 1 90); do
    if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] &&
      [[ "$(adb shell getprop init.svc.bootanim 2>/dev/null | tr -d '\r')" == "stopped" ]] &&
      adb shell service check input 2>/dev/null | grep -q ': found' &&
      adb shell service check input_method 2>/dev/null | grep -q ': found' &&
      adb shell pm path android >/dev/null 2>&1 &&
      adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1; then
      adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
      return 0
    fi
    sleep 2
  done
  echo "::error::The emulator's input and package services were not ready 180 s after boot."
  return 1
}

# Presses a button in whatever window has focus, found by its text in a
# uiautomator dump. Only for use before Agent Device holds the UI Automation
# connection, which Android grants to one client at a time.
press_system_button() {
  local text="$1" bounds
  adb shell uiautomator dump /sdcard/e2e-window.xml >/dev/null 2>&1 || return 1
  bounds="$(adb exec-out cat /sdcard/e2e-window.xml 2>/dev/null |
    grep -o "text=\"${text}\"[^>]*bounds=\"\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]\"" |
    grep -o '\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]' | head -n 1 | tr -d '[' | tr ']' ',')"
  [[ -n "${bounds}" ]] || return 1
  IFS=, read -r left top right bottom _ <<<"${bounds}"
  adb shell input tap "$(((left + right) / 2))" "$(((top + bottom) / 2))"
}

# System UI and the launcher on a shared runner often miss the input deadline
# right after boot, and their "isn't responding" dialog covers the app for the
# rest of the run. hide_error_dialogs keeps later ANR and crash dialogs off
# screen; the system reads it on the next configuration change, which the
# font scale nudge forces. A dialog that is already up gets "Wait". Returns
# once the launcher has held focus for three checks in a row.
settle_system_ui() {
  adb shell settings put global hide_error_dialogs 1 >/dev/null 2>&1 || true
  adb shell settings put system font_scale 1.01 >/dev/null 2>&1 || true
  adb shell settings put system font_scale 1.0 >/dev/null 2>&1 || true
  local focus steady=0
  for _ in $(seq 1 60); do
    focus="$(adb shell dumpsys window 2>/dev/null | grep -m1 'mCurrentFocus=' || true)"
    if [[ "${focus}" == *"Not Responding"* || "${focus}" == *"Application Error"* ]]; then
      echo "Dismissing a system dialog: ${focus}"
      steady=0
      press_system_button "Wait" || adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
    elif [[ "${focus}" == *"launcher"* || "${focus}" == *"Launcher"* ]]; then
      steady=$((steady + 1))
      [[ "${steady}" -ge 3 ]] && return 0
    else
      steady=0
      adb shell input keyevent KEYCODE_HOME >/dev/null 2>&1 || true
    fi
    sleep 2
  done
  echo "::warning::The launcher never took focus; last focus: ${focus}"
}

install_apk() {
  # The cached AVD's data partition can still hold the app from the run that
  # saved the cache; start from a fresh install so onboarding runs.
  adb uninstall "${APP_ID}" >/dev/null 2>&1 || true
  for attempt in 1 2 3; do
    # -g grants runtime permissions up front, so no notification prompt
    # covers the app after it connects.
    if adb install -g "${APK_PATH}"; then
      return 0
    fi
    echo "::warning::APK install attempt ${attempt} failed; retrying."
    sleep 10
  done
  echo "::error::Could not install ${APK_PATH}."
  return 1
}

run_suite() {
  local name="$1"
  shift
  echo "::group::${name}"
  if "$@"; then
    echo "::endgroup::"
    echo "${name}: passed"
  else
    echo "::endgroup::"
    echo "::error::${name} failed."
    failed+=("${name}")
  fi
}

wait_for_device || exit 1
settle_system_ui
install_apk || exit 1
# The app dials 127.0.0.1:<port> on the device; adb forwards it to the daemon.
adb reverse "tcp:${DAEMON_PORT}" "tcp:${DAEMON_PORT}"
adb logcat -c || true
adb logcat -v threadtime >"${ARTIFACTS_DIR}/logcat.txt" 2>&1 &
logcat_pid=$!
settle_system_ui

AGENT_DEVICE_STATE_DIR="${RUNNER_TEMP:-/tmp}/agent-device-connect" agent-device replay \
  "${SRC_DIR}/packages/app/e2e/mobile/setup/connect-direct.android.ad" \
  --platform android \
  --session connect \
  --env "APP_ID=${APP_ID}" \
  --env "DAEMON_HOST=127.0.0.1" \
  --env "DAEMON_PORT=${DAEMON_PORT}" \
  --env "SERVER_ID=${SERVER_ID}" \
  --env "WORKSPACE_ID=${WORKSPACE_ID}"
connect_status=$?
AGENT_DEVICE_STATE_DIR="${RUNNER_TEMP:-/tmp}/agent-device-connect" agent-device daemon stop --clean >/dev/null 2>&1 || true
if [[ "${connect_status}" -ne 0 ]]; then
  echo "::error::Could not connect the app to the E2E daemon; no suite ran."
  adb exec-out screencap -p >"${ARTIFACTS_DIR}/connect-failure.png" 2>/dev/null || true
  exit 1
fi

export PASEO_MOBILE_E2E_APP_ID="${APP_ID}"
run_suite "Agent Device Android scripts" env \
  PASEO_MOBILE_E2E_PLATFORM=android \
  PASEO_MOBILE_E2E_METRO=0 \
  PASEO_MOBILE_E2E_ARTIFACTS_DIR="${ARTIFACTS_DIR}/agent-device" \
  bash "${SRC_DIR}/scripts/test-mobile-agent-device.sh"
run_suite "File editor" env \
  PASEO_E2E_WORKSPACE_DIR="${WORKSPACE_DIR}" \
  PASEO_MOBILE_E2E_ARTIFACTS_DIR="${ARTIFACTS_DIR}/agent-device" \
  bash "${SRC_DIR}/packages/app/e2e/mobile/file-editor/android.sh"

if [[ "${#failed[@]}" -gt 0 ]]; then
  echo "Failed suites: ${failed[*]}"
  exit 1
fi
echo "All Android E2E suites passed."
