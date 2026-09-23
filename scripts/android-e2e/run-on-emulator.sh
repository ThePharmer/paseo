#!/usr/bin/env bash
# Runs inside android-emulator-runner once the emulator has booted: installs
# the APK, connects the app to the E2E daemon, and runs the Android suites
# from the built source. Every suite runs even after an earlier one fails, so
# one run reports every broken flow; the exit status is non-zero if any failed.
#
# Needs: SRC_DIR, APK_PATH, APP_ID, DAEMON_PORT, SERVER_ID, WORKSPACE_ID,
# WORKSPACE_DIR, ARTIFACTS_DIR.
#
# Experiment mode: CONNECT_TRIALS > 0 skips connecting and the suites and runs
# that many cold-start trials of opening the Direct connection sheet instead
# (see run_connect_trials). E2E_ANIMATIONS=enabled|disabled sets the system
# animation scales for the whole run.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONNECT_TRIALS="${CONNECT_TRIALS:-0}"
E2E_ANIMATIONS="${E2E_ANIMATIONS:-disabled}"

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
# font scale nudge forces. It also hides the app's own crash dialog, so a
# crash shows up as a failed wait; logcat.txt in the artifact has the trace. A dialog that is already up gets "Wait". Returns
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

# Copies Agent Device's per-request diagnostics (.ndjson) out of a state dir
# before `daemon stop --clean` removes them.
save_agent_device_diagnostics() {
  local state_dir="$1" dest="$2"
  [[ -d "${state_dir}" ]] || return 0
  mkdir -p "${dest}"
  (cd "${state_dir}" && find . -name '*.ndjson' -print0 | xargs -0 -r cp --parents -t "${dest}") 2>/dev/null || true
}

# Sets the three system animation scales (1 = on, 0 = off). Reanimated reads
# transition_animation_scale == 0 as the system Reduce Motion setting.
apply_animation_setting() {
  local scale=0
  [[ "${E2E_ANIMATIONS}" == "enabled" ]] && scale=1
  for key in window_animation_scale transition_animation_scale animator_duration_scale; do
    adb shell settings put global "${key}" "${scale}" >/dev/null 2>&1 || true
  done
  echo "Animations ${E2E_ANIMATIONS}: window=$(adb shell settings get global window_animation_scale | tr -d '\r')" \
    "transition=$(adb shell settings get global transition_animation_scale | tr -d '\r')" \
    "animator=$(adb shell settings get global animator_duration_scale | tr -d '\r')"
}

# EXPERIMENT: each trial reinstalls the APK (a fresh first launch, like the
# first connect of a normal run), opens the app, waits for the welcome screen,
# taps Direct connection at once and waits the normal 10 s for the sheet. No
# retry inside a trial. A trial that fails before the tap is counted apart,
# since it says nothing about the sheet.
run_connect_trials() {
  local trials="$1" opened=0 stuck=0 other=0 trial status log state failed_step outcome
  local summary="${ARTIFACTS_DIR}/connect-trials.md"
  mkdir -p "${ARTIFACTS_DIR}/trials"
  {
    echo "## Direct connection sheet: ${trials} cold-start trials"
    echo
    echo "APK: \`${APK_PATH##*/}\` (native headers run ${BUILD_RUN_ID:-unknown}); animations: **${E2E_ANIMATIONS}**" \
      "(transition_animation_scale=$(adb shell settings get global transition_animation_scale | tr -d '\r'))"
    echo
    echo "| Trial | Result | Started (UTC) | Failed step |"
    echo "| --- | --- | --- | --- |"
  } >"${summary}"
  for trial in $(seq 1 "${trials}"); do
    log="${ARTIFACTS_DIR}/trials/trial-${trial}.log"
    state="${RUNNER_TEMP:-/tmp}/agent-device-trial-${trial}"
    if ! install_apk; then
      other=$((other + 1))
      echo "| ${trial} | install failed | $(date -u +%T) | |" >>"${summary}"
      continue
    fi
    settle_system_ui
    local started
    started="$(date -u +%T)"
    adb shell log -t PaseoE2ETrial "trial ${trial} start" >/dev/null 2>&1 || true
    AGENT_DEVICE_STATE_DIR="${state}" agent-device replay \
      "${SCRIPT_DIR}/connect-trial.android.ad" \
      --platform android \
      --session "trial-${trial}" \
      --env "APP_ID=${APP_ID}" 2>&1 | tee "${log}"
    status="${PIPESTATUS[0]}"
    adb shell log -t PaseoE2ETrial "trial ${trial} end status=${status}" >/dev/null 2>&1 || true
    failed_step="$(grep -o -m 1 'Replay failed at step [0-9]* ([^)]*)' "${log}" || true)"
    if [[ "${status}" -eq 0 ]]; then
      opened=$((opened + 1))
      outcome="sheet opened"
    else
      adb exec-out screencap -p >"${ARTIFACTS_DIR}/trials/trial-${trial}-failure.png" 2>/dev/null || true
      if grep -q 'id=\\"add-host-modal\\"' <<<"${failed_step}"; then
        stuck=$((stuck + 1))
        outcome="**sheet did not open**"
        grep -q 'Bottom sheet backdrop' "${log}" && outcome="${outcome} (backdrop only)"
      else
        other=$((other + 1))
        outcome="failed before the sheet"
      fi
    fi
    echo "| ${trial} | ${outcome} | ${started} | ${failed_step//|/\\|} |" >>"${summary}"
    save_agent_device_diagnostics "${state}" "${ARTIFACTS_DIR}/trials/trial-${trial}-diagnostics"
    AGENT_DEVICE_STATE_DIR="${state}" agent-device daemon stop --clean >/dev/null 2>&1 || true
  done
  local counted=$((opened + stuck))
  {
    echo
    echo "**Sheet opened in ${opened} of ${counted} trials** that reached the tap; did not open in ${stuck}." \
      "${other} trial(s) failed before the tap and are not counted."
  } >>"${summary}"
  cat "${summary}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    cat "${summary}" >>"${GITHUB_STEP_SUMMARY}"
  fi
  [[ "${stuck}" -eq 0 && "${counted}" -gt 0 ]]
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
if ! adb reverse "tcp:${DAEMON_PORT}" "tcp:${DAEMON_PORT}"; then
  echo "::error::adb reverse tcp:${DAEMON_PORT} failed, so the app cannot reach the daemon; no suite ran."
  exit 1
fi
adb logcat -c || true
adb logcat -v threadtime >"${ARTIFACTS_DIR}/logcat.txt" 2>&1 &
logcat_pid=$!
apply_animation_setting
settle_system_ui

if [[ "${CONNECT_TRIALS}" -gt 0 ]]; then
  run_connect_trials "${CONNECT_TRIALS}"
  exit $?
fi

# Replays the connect script; its output goes to connect-attempt-<n>.log in the
# artifact as well as the job log.
connect_app() {
  local attempt="$1" status
  AGENT_DEVICE_STATE_DIR="${RUNNER_TEMP:-/tmp}/agent-device-connect" agent-device replay \
    "${SRC_DIR}/packages/app/e2e/mobile/setup/connect-direct.android.ad" \
    --platform android \
    --session connect \
    --env "APP_ID=${APP_ID}" \
    --env "DAEMON_HOST=127.0.0.1" \
    --env "DAEMON_PORT=${DAEMON_PORT}" \
    --env "SERVER_ID=${SERVER_ID}" \
    --env "WORKSPACE_ID=${WORKSPACE_ID}" 2>&1 | tee "${ARTIFACTS_DIR}/connect-attempt-${attempt}.log"
  status="${PIPESTATUS[0]}"
  save_agent_device_diagnostics "${RUNNER_TEMP:-/tmp}/agent-device-connect" \
    "${ARTIFACTS_DIR}/connect-attempt-${attempt}-diagnostics"
  AGENT_DEVICE_STATE_DIR="${RUNNER_TEMP:-/tmp}/agent-device-connect" agent-device daemon stop --clean >/dev/null 2>&1 || true
  return "${status}"
}

# Reports a used retry as a warning annotation and in the job summary, so a
# green run still shows that the first attempt failed.
report_connect_retry() {
  local failed_step message
  failed_step="$(grep -o -m 1 'Replay failed at step [0-9]* ([^)]*)' "${ARTIFACTS_DIR}/connect-attempt-1.log" || true)"
  if grep -q 'id=\\"add-host-modal\\"' <<<"${failed_step}"; then
    message="Direct connection sheet did not open on first attempt (known app bug, see connect-failure-1.png); retried"
  else
    message="Connecting the app failed on first attempt (${failed_step:-no replay step reported}; see connect-failure-1.png and connect-attempt-1.log); retried"
  fi
  echo "::warning::${message}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "- :warning: ${message}" >>"${GITHUB_STEP_SUMMARY}"
  fi
}

# TEMPORARY until the app bug where the Direct connection sheet shows its
# backdrop but never slides in is fixed; then drop the retry. Connecting is
# setup, not a test, so it gets exactly one retry on the same install: the
# app is force-stopped, which dismisses the stuck sheet, and since the failed
# attempt saved no host it relaunches to the welcome screen. The suites below
# get no retry.
connected=false
if connect_app 1; then
  connected=true
else
  adb exec-out screencap -p >"${ARTIFACTS_DIR}/connect-failure-1.png" 2>/dev/null || true
  report_connect_retry
  adb shell am force-stop "${APP_ID}"
  settle_system_ui
  if connect_app 2; then
    connected=true
  else
    adb exec-out screencap -p >"${ARTIFACTS_DIR}/connect-failure-2.png" 2>/dev/null || true
  fi
fi
if [[ "${connected}" != "true" ]]; then
  echo "::error::Could not connect the app to the E2E daemon after one retry; no suite ran. See connect-failure-*.png and connect-attempt-*.log."
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
