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
  # adb, not the session: a failed replay may have closed it.
  adb exec-out screencap -p >"${ARTIFACTS_DIR}/${name}-failure.png" || true
  ad snapshot -i --json >"${ARTIFACTS_DIR}/${name}-failure.json" || true
}

cleanup() {
  chmod -R u+w "${WORKSPACE_DIR}" 2>/dev/null || true
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device daemon stop --clean >/dev/null 2>&1 || true
}

# Polls a host file until its bytes equal the text exactly, trailing newline
# included (command substitution would strip it, so compare with cmp).
expect_file() {
  local file="$1" text="$2" timeout_s="${3:-15}"
  CURRENT_STEP="host check ${file}"
  for _ in $(seq 1 "$((timeout_s * 4))"); do
    if cmp -s -- "${file}" <(printf '%s' "${text}"); then
      return
    fi
    sleep 0.25
  done
  # od -c prints every \n, so a missing or extra final newline shows.
  echo "Expected ${file} to hold exactly:" >&2
  printf '%s' "${text}" | od -c >&2
  echo "within ${timeout_s}s; it holds:" >&2
  head -c 2000 "${file}" | od -c >&2
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

# Each write is checked before Done: closing the editor saves a dirty buffer,
# so a check after Done alone cannot tell which step wrote the file.

# Autosave writes the edit while the editor is still open, and Done returns to
# the read-only viewer showing it without changing the file.
notes=$'First line\nSecond line\n'"${AUTOSAVED}"
replay autosave-type --env "FILE=notes.txt" --env "MARKER=${AUTOSAVED}"
expect_file "${WORKSPACE_DIR}/notes.txt" "${notes}"
replay done --env "MARKER=${AUTOSAVED}"
expect_file "${WORKSPACE_DIR}/notes.txt" "${notes}"

replay size-cap --env "FILE=large.txt"
replay find --env "FILE=find.txt"

# Reload discards the local edit and keeps the host's version on disk.
conflict_with_host_edit reload-dir reload-me.txt "${HOST_EDIT}"
replay conflict-reload --env "DISK_TEXT=${HOST_EDIT}"
expect_file "${WORKSPACE_DIR}/reload-dir/reload-me.txt" "${HOST_EDIT}"$'\n'

# Overwrite replaces the host's version with the editor's buffer, and Done
# then leaves it alone.
overwritten=$'Original overwrite line\n'"${LOCAL_EDIT}"
conflict_with_host_edit overwrite-dir overwrite-me.txt "${HOST_EDIT}"
replay conflict-overwrite
expect_file "${WORKSPACE_DIR}/overwrite-dir/overwrite-me.txt" "${overwritten}"
replay done --env "MARKER=${LOCAL_EDIT}"
expect_file "${WORKSPACE_DIR}/overwrite-dir/overwrite-me.txt" "${overwritten}"

echo "File editor E2E passed"
