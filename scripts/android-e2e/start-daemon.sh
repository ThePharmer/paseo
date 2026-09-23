#!/usr/bin/env bash
# Starts an isolated Paseo daemon for the Android E2E workflow and registers a
# fixture workspace with it. Run on the CI runner, never on a machine whose
# daemon matters: it uses a fresh home and no password.
#
# Usage: start-daemon.sh <built source checkout> <work dir> <port>
# Appends PASEO_HOME, DAEMON_PID, SERVER_ID, WORKSPACE_ID and WORKSPACE_DIR to
# $GITHUB_ENV when it is set, and prints them either way.
set -euo pipefail

src="$(cd "$1" && pwd)"
work="$2"
port="$3"
home="${work}/paseo-home"
workspace="${work}/workspace"
cli=(node "${src}/packages/cli/bin/paseo")

mkdir -p "${home}" "${workspace}"
workspace="$(cd "${workspace}" && pwd -P)"

# A git repository, so the explorer offers the same tabs as a real project.
# The E2E scripts add their own files.
printf '# Android E2E fixture\n' >"${workspace}/README.md"
git -C "${workspace}" init -q -b main
git -C "${workspace}" -c user.name=e2e -c user.email=e2e@example.invalid add README.md
git -C "${workspace}" -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m fixture

# The supervisor entrypoint is the supported launch path (docs/ad-hoc-daemon-testing.md).
# No relay, no speech model downloads, any Origin. Binding loopback is enough:
# the emulator reaches it through `adb reverse`.
PASEO_HOME="${home}" \
  PASEO_LISTEN="127.0.0.1:${port}" \
  PASEO_RELAY_ENABLED=0 \
  PASEO_DICTATION_ENABLED=0 \
  PASEO_VOICE_MODE_ENABLED=0 \
  PASEO_CORS_ORIGINS='*' \
  SHELL=/bin/bash \
  nohup node "${src}/packages/server/dist/scripts/supervisor-entrypoint.js" --no-relay \
  >"${work}/daemon.out" 2>&1 &
daemon_pid=$!

export PASEO_HOME="${home}"
ready=false
for _ in $(seq 1 120); do
  if ! kill -0 "${daemon_pid}" 2>/dev/null; then
    echo "::error::The daemon exited during startup."
    cat "${work}/daemon.out"
    exit 1
  fi
  if "${cli[@]}" daemon status --host "127.0.0.1:${port}" --json >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "${ready}" != "true" ]]; then
  echo "::error::The daemon did not accept connections on 127.0.0.1:${port} within 120 s."
  tail -n 100 "${work}/daemon.out"
  exit 1
fi

"${cli[@]}" project create "${workspace}" --host "127.0.0.1:${port}" --json >"${work}/project.json"
project_id="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).projectId' "${work}/project.json")"
"${cli[@]}" workspace create --isolation local --path "${workspace}" --project "${project_id}" \
  --host "127.0.0.1:${port}" --json >/dev/null
"${cli[@]}" workspace ls --host "127.0.0.1:${port}" --json >"${work}/workspaces.json"
workspace_id="$(node -e '
  const [file, cwd] = process.argv.slice(1);
  const rows = JSON.parse(require("fs").readFileSync(file, "utf8"));
  const row = rows.find((candidate) => candidate.cwd === cwd);
  if (!row) {
    console.error(`No workspace for ${cwd}: ${JSON.stringify(rows)}`);
    process.exit(1);
  }
  process.stdout.write(row.workspaceId);
' "${work}/workspaces.json" "${workspace}")"
server_id="$(<"${home}/server-id")"

{
  echo "PASEO_HOME=${home}"
  echo "DAEMON_PID=${daemon_pid}"
  echo "SERVER_ID=${server_id}"
  echo "WORKSPACE_ID=${workspace_id}"
  echo "WORKSPACE_DIR=${workspace}"
} | tee -a "${GITHUB_ENV:-/dev/null}"
