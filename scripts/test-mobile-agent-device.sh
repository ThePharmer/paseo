#!/usr/bin/env bash
# Runs the Agent Device mobile suite. With no arguments it runs every script in
# packages/app/e2e/mobile/agent-device; pass script paths to run only those.
#
#   PASEO_MOBILE_E2E_PLATFORM   ios or android: run only that platform's scripts
#                               and prepare only its tooling (default: all).
#   PASEO_MOBILE_E2E_APP_ID     Override the scripts' APP_ID, e.g. sh.paseo for
#                               a release APK (default: each script's own).
#   PASEO_MOBILE_E2E_METRO      0 for a release build that embeds its bundle,
#                               so no Metro is started or checked (default: 1).
#   PASEO_MOBILE_E2E_METRO_PORT Metro port when Metro is used (default: 8081).
#   PASEO_MOBILE_E2E_RECORD_VIDEO  1 to record every attempt into its artifacts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE_DIR="${REPO_ROOT}/packages/app/e2e/mobile/agent-device"
STATE_DIR="${PASEO_MOBILE_E2E_STATE_DIR:-${REPO_ROOT}/.dev/agent-device-e2e}"
ARTIFACTS_DIR="${PASEO_MOBILE_E2E_ARTIFACTS_DIR:-${REPO_ROOT}/.dev/agent-device-artifacts}"
PLATFORM="${PASEO_MOBILE_E2E_PLATFORM:-}"
APP_ID="${PASEO_MOBILE_E2E_APP_ID:-}"
USE_METRO="${PASEO_MOBILE_E2E_METRO:-1}"
METRO_PORT="${PASEO_MOBILE_E2E_METRO_PORT:-8081}"
METRO_PID=0

case "${PLATFORM}" in
  "" | ios | android) ;;
  *)
    echo "PASEO_MOBILE_E2E_PLATFORM must be ios or android, got '${PLATFORM}'" >&2
    exit 2
    ;;
esac

if [[ "$#" -gt 0 ]]; then
  SCRIPTS=("$@")
elif [[ -n "${PLATFORM}" ]]; then
  SCRIPTS=("${SUITE_DIR}"/*."${PLATFORM}".ad)
else
  SCRIPTS=("${SUITE_DIR}")
fi

cleanup() {
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device daemon stop --clean >/dev/null 2>&1 || true
  if [[ "${METRO_PID}" -gt 0 ]]; then
    pkill -TERM -P "${METRO_PID}" >/dev/null 2>&1 || true
    kill -TERM "${METRO_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM
cleanup
mkdir -p "${STATE_DIR}" "${ARTIFACTS_DIR}"

TEST_ARGS=(
  --timeout 120000
  --fail-fast
  --artifacts-dir "${ARTIFACTS_DIR}"
)
if [[ -n "${PLATFORM}" ]]; then
  TEST_ARGS+=(--platform "${PLATFORM}")
fi
if [[ -n "${APP_ID}" ]]; then
  TEST_ARGS+=(--env "APP_ID=${APP_ID}")
fi
if [[ "${PASEO_MOBILE_E2E_RECORD_VIDEO:-0}" == "1" ]]; then
  TEST_ARGS+=(--record-video)
fi

if [[ "${USE_METRO}" != "0" ]]; then
  METRO_RESULT="$({
    AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device metro prepare \
      --project-root "${REPO_ROOT}/packages/app" \
      --kind expo \
      --port "${METRO_PORT}" \
      --public-base-url "http://127.0.0.1:${METRO_PORT}" \
      --json
  })"
  printf '%s\n' "${METRO_RESULT}"
  METRO_PID="$(printf '%s' "${METRO_RESULT}" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const result = JSON.parse(input);
      process.stdout.write(String(result.data?.started ? result.data.pid : 0));
    });
  ')"
  TEST_ARGS+=(--metro-port "${METRO_PORT}")
fi

if [[ "${PLATFORM}" != "android" ]]; then
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device prepare ios-runner \
    --platform ios \
    --timeout 120000
fi

AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device test "${SCRIPTS[@]}" "${TEST_ARGS[@]}"
