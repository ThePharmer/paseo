#!/usr/bin/env bash
# Native file editor E2E on Android. Needs a booted emulator whose app is
# connected to a daemon with PASEO_E2E_WORKSPACE_DIR open as its active
# workspace. The daemon must run on this machine as a non-root user: the
# harness writes the fixture files into that directory, changes them behind
# the app's back, and asserts what the app saved.
#
# Each flow is one or more .ad scripts replayed in one Agent Device session.
# Scripts that end without `close` leave the app mid-flow so the harness can
# act on the host before the next script continues it.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../../../.." && pwd)"
WORKSPACE_DIR="${PASEO_E2E_WORKSPACE_DIR:?Set PASEO_E2E_WORKSPACE_DIR to the workspace directory the app has open}"
APP_ID="${PASEO_MOBILE_E2E_APP_ID:-sh.paseo}"
STATE_DIR="${PASEO_MOBILE_E2E_STATE_DIR:-${REPO_ROOT}/.dev/agent-device-file-editor}"
ARTIFACTS_DIR="${PASEO_MOBILE_E2E_ARTIFACTS_DIR:-${REPO_ROOT}/.dev/agent-device-artifacts}/file-editor"
SESSION="file-editor-android"
CURRENT_STEP="setup"

ad() {
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device "$@" --session "${SESSION}"
}

replay() {
  local script="$1"
  shift
  CURRENT_STEP="${script}"
  echo "--- ${script}"
  ad replay "${HERE}/${script}.android.ad" --platform android --env "APP_ID=${APP_ID}" "$@"
}

on_failure() {
  local name="${CURRENT_STEP//\//-}"
  echo "File editor E2E failed during ${CURRENT_STEP}" >&2
  ad screenshot "${ARTIFACTS_DIR}/${name}-failure.png" >/dev/null 2>&1 || true
  ad snapshot -i --json >"${ARTIFACTS_DIR}/${name}-failure.json" 2>/dev/null || true
}

cleanup() {
  chmod -R u+w "${WORKSPACE_DIR}" 2>/dev/null || true
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device daemon stop --clean >/dev/null 2>&1 || true
}

# Polls a host file until it contains (or, with "exact", equals) the text.
expect_file() {
  local mode="$1" file="$2" text="$3" timeout_s="${4:-15}"
  CURRENT_STEP="host check ${file}"
  for _ in $(seq 1 "$((timeout_s * 4))"); do
    if [[ "${mode}" == "exact" && "$(<"${file}")" == "${text}" ]]; then
      return
    fi
    if [[ "${mode}" == "contains" ]] && grep -qF -- "${text}" "${file}"; then
      return
    fi
    sleep 0.25
  done
  echo "Expected ${file} to ${mode} '${text}' within ${timeout_s}s; it holds:" >&2
  head -c 2000 "${file}" >&2
  return 1
}

write_fixtures() {
  printf 'First line\nSecond line\n' >"${WORKSPACE_DIR}/notes.txt"
  printf 'needle one\nhaystack\nneedle two\n' >"${WORKSPACE_DIR}/find.txt"
  # 600 KiB of text, over the 512 KiB native edit cap and under the 1 MiB
  # highlighted-viewer limit.
  node -e 'process.stdout.write(`${"x".repeat(59)}\n`.repeat(10240))' >"${WORKSPACE_DIR}/large.txt"
  mkdir -p "${WORKSPACE_DIR}/reload-dir" "${WORKSPACE_DIR}/overwrite-dir"
  printf 'Original reload line\n' >"${WORKSPACE_DIR}/reload-dir/reload-me.txt"
  printf 'Original overwrite line\n' >"${WORKSPACE_DIR}/overwrite-dir/overwrite-me.txt"
}

# Leaves the file with local edits the app could not save, changes it on the
# host, then unlocks its directory so an Overwrite can succeed. A read-only
# directory makes the daemon's atomic write (temp file plus rename) fail,
# which keeps the edits unsaved without racing the 800 ms autosave.
conflict_with_host_edit() {
  local dir="$1" file="$2" host_text="$3"
  chmod a-w "${WORKSPACE_DIR}/${dir}"
  replay conflict-type --env "DIR=${dir}" --env "FILE=${file}" --env "MARKER=${LOCAL_EDIT}"
  printf '%s\n' "${host_text}" >"${WORKSPACE_DIR}/${dir}/${file}"
  chmod u+w "${WORKSPACE_DIR}/${dir}"
}

trap 'on_failure' ERR
trap cleanup EXIT INT TERM
cleanup
mkdir -p "${STATE_DIR}" "${ARTIFACTS_DIR}"
write_fixtures

AUTOSAVED="E2E_AUTOSAVED_LINE"
LOCAL_EDIT="E2E_LOCAL_EDIT"
HOST_EDIT="E2E_HOST_EDIT"

# Autosave writes the edit while the editor is still open, and Done returns to
# the read-only viewer showing it.
replay autosave-type --env "FILE=notes.txt" --env "MARKER=${AUTOSAVED}"
expect_file contains "${WORKSPACE_DIR}/notes.txt" "${AUTOSAVED}"
replay autosave-done --env "MARKER=${AUTOSAVED}"
expect_file exact "${WORKSPACE_DIR}/notes.txt" $'First line\nSecond line\n'"${AUTOSAVED}"

replay size-cap --env "FILE=large.txt"
replay find --env "FILE=find.txt"

# Reload discards the local edit and keeps the host's version on disk.
conflict_with_host_edit reload-dir reload-me.txt "${HOST_EDIT}"
replay conflict-reload --env "DISK_TEXT=${HOST_EDIT}"
expect_file exact "${WORKSPACE_DIR}/reload-dir/reload-me.txt" "${HOST_EDIT}"

# Overwrite replaces the host's version with the editor's buffer.
conflict_with_host_edit overwrite-dir overwrite-me.txt "${HOST_EDIT}"
replay conflict-overwrite --env "MARKER=${LOCAL_EDIT}"
expect_file exact "${WORKSPACE_DIR}/overwrite-dir/overwrite-me.txt" $'Original overwrite line\n'"${LOCAL_EDIT}"

echo "File editor E2E passed"
