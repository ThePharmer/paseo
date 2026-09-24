#!/usr/bin/env bash
# Regression check for the Direct connection sheet under system Reduce Motion
# on Android (docs/floating-panels.md, Gotcha 7). With the animation scales at
# 0, which Reanimated reads as Reduce Motion, a Gorhom sheet could show only
# its backdrop on a cold first launch. Each trial reinstalls the APK, opens
# the app, taps Direct connection at once and expects add-host-modal. Before
# the fix about one trial in eleven failed, so this is a smoke check; the
# connect setup step adds one more cold start per run.
#
# Needs a booted emulator. Reinstalling wipes the app, including a connected
# host, so run it after the suites that need a connection. Restores the
# animation scales it found on exit.
#
#   PASEO_E2E_APK_PATH          APK to reinstall for each trial (required).
#   PASEO_MOBILE_E2E_APP_ID     Package name (default: sh.paseo).
#   PASEO_E2E_SHEET_TRIALS      Cold starts to check (default: 3).
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../../../.." && pwd)"
APK_PATH="${PASEO_E2E_APK_PATH:?Set PASEO_E2E_APK_PATH to the APK to reinstall for each trial}"
APP_ID="${PASEO_MOBILE_E2E_APP_ID:-sh.paseo}"
TRIALS="${PASEO_E2E_SHEET_TRIALS:-3}"
STATE_DIR="${PASEO_MOBILE_E2E_STATE_DIR:-${REPO_ROOT}/.dev/agent-device-direct-connection-sheet}"
ARTIFACTS_DIR="${PASEO_MOBILE_E2E_ARTIFACTS_DIR:-${REPO_ROOT}/.dev/agent-device-artifacts}/direct-connection-sheet"
SESSION="direct-connection-sheet-android"
SCALE_KEYS=(window_animation_scale transition_animation_scale animator_duration_scale)
declare -A saved_scales=()
CURRENT_STEP="setup"

on_failure() {
  echo "Direct connection sheet E2E failed during ${CURRENT_STEP}" >&2
  # adb, not the session: a failed replay may have closed it.
  adb exec-out screencap -p >"${ARTIFACTS_DIR}/${CURRENT_STEP// /-}-failure.png" || true
}

cleanup() {
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device daemon stop --clean >/dev/null 2>&1 || true
  for key in "${!saved_scales[@]}"; do
    adb shell settings put global "${key}" "${saved_scales[${key}]}" >/dev/null 2>&1 || true
  done
}

trap 'on_failure' ERR
trap cleanup EXIT INT TERM
cleanup
mkdir -p "${STATE_DIR}" "${ARTIFACTS_DIR}"

for key in "${SCALE_KEYS[@]}"; do
  value="$(adb shell settings get global "${key}" | tr -d '\r')"
  # An unset scale reads as "null"; 1 is its default.
  [[ "${value}" == "null" || -z "${value}" ]] && value=1
  saved_scales["${key}"]="${value}"
  adb shell settings put global "${key}" 0
done

for trial in $(seq 1 "${TRIALS}"); do
  CURRENT_STEP="trial ${trial} install"
  adb uninstall "${APP_ID}" >/dev/null 2>&1 || true
  adb install -g "${APK_PATH}" >/dev/null
  CURRENT_STEP="trial ${trial}"
  echo "--- trial ${trial} of ${TRIALS}"
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device replay "${HERE}/open.android.ad" \
    --platform android --session "${SESSION}" --env "APP_ID=${APP_ID}"
done

echo "Direct connection sheet E2E passed (${TRIALS} cold starts)"
