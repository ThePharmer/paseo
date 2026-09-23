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

install_apk() {
  for attempt in 1 2 3; do
    # -g grants runtime permissions up front, so no notification prompt
    # covers the app after it connects.
    if adb install -r -g "${APK_PATH}"; then
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
adb shell settings put secure show_ime_with_hard_keyboard 0 >/dev/null 2>&1 || true
install_apk || exit 1
# The app dials 127.0.0.1:<port> on the device; adb forwards it to the daemon.
adb reverse "tcp:${DAEMON_PORT}" "tcp:${DAEMON_PORT}"
adb logcat -c || true
adb logcat -v threadtime >"${ARTIFACTS_DIR}/logcat.txt" 2>&1 &
logcat_pid=$!

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
