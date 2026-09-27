#!/usr/bin/env bash
# Streaming memory scenario for the Android E2E workflow. Runs inside
# run-on-emulator.sh after the app is connected. Opens one mock agent's chat
# and has it stream a long, code-heavy assistant message while the app's
# memory is sampled, so runs with the daemon's PASEO_ASSISTANT_TEXT_DELIVERY
# set to token and to paragraph compare directly. It measures, it does not
# assert: the job fails only when the app process dies or setup breaks.
#
# Needs: APP_ID, DAEMON_PORT, SERVER_ID, WORKSPACE_ID, WORKSPACE_DIR,
# ARTIFACTS_DIR, DAEMON_SRC_DIR. TEXT_DELIVERY labels the summary. MEMORY_CONFIG
# overrides the defaults below as space-separated key=value pairs, e.g.
# "blocks=120 repeats=3".
set -uo pipefail

: "${APP_ID:?}" "${DAEMON_PORT:?}" "${SERVER_ID:?}" "${WORKSPACE_ID:?}" "${WORKSPACE_DIR:?}"
: "${ARTIFACTS_DIR:?}" "${DAEMON_SRC_DIR:?}"

blocks=60            # prose paragraph + fenced code block sections per turn
lines=40             # lines per code block
step_ms=20           # delay between streamed tokens
baseline_s=30        # idle sampling before the agent starts
settle_s=60          # sampling after the last turn
sample_s=5           # meminfo interval
repeats=1            # prompts sent to the same agent, each after the previous turn
turn_timeout_s=1200  # longest a turn may take
# shellcheck source=memory-common.sh
source "$(dirname "$0")/memory-common.sh"
parse_memory_config blocks lines step_ms baseline_s settle_s sample_s repeats turn_timeout_s || exit 1
if [[ "${repeats}" -lt 1 || "${sample_s}" -lt 1 ]]; then
  echo "::error::MEMORY_CONFIG repeats and sample_s must be at least 1."
  exit 1
fi

out="${ARTIFACTS_DIR}/stream-memory"
mkdir -p "${out}"
csv="${out}/meminfo.csv"
events="${out}/events.log"
cli=(node "${DAEMON_SRC_DIR}/packages/cli/bin/paseo")
host=(--host "127.0.0.1:${DAEMON_PORT}")
prompt="Stream ${blocks} code blocks of ${lines} lines every ${step_ms} ms."
text_delivery="${TEXT_DELIVERY:-default}"

agent_status() {
  "${cli[@]}" ls -g --json "${host[@]}" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const agent = JSON.parse(s).find((row) => row.id === process.argv[1]);
        console.log(agent ? agent.status : "missing");
      } catch {
        console.log("");
      }
    });
  ' "${agent_id}"
}

# Waits until the agent's current turn finishes. A turn counts as finished once
# the agent is idle after having been seen running; an agent that never shows
# running within 30 s but is idle counts as finished too (a very short turn).
# Returns 0 when the turn finished, 1 on timeout or an agent error, 2 when the
# app process died meanwhile. Sets turn_seconds, counted from <sent epoch>.
wait_for_turn() {
  local label="$1" start="$2" started=false status="" now
  while :; do
    now="$(date +%s)"
    turn_seconds=$((now - start))
    if [[ "$(app_pid)" != "${start_pid}" ]]; then
      log_event "${label}: app process changed during the turn"
      return 2
    fi
    status="$(agent_status)"
    case "${status}" in
      running) started=true ;;
      idle)
        if [[ "${started}" == "true" ]] || [[ "${turn_seconds}" -ge 30 ]]; then
          [[ "${started}" == "true" ]] || log_event "${label}: never saw the agent running"
          log_event "${label}: finished after ${turn_seconds} s"
          return 0
        fi
        ;;
      error | closed)
        log_event "${label}: agent status ${status}"
        return 1
        ;;
      missing)
        if [[ "${turn_seconds}" -ge 30 ]]; then
          log_event "${label}: agent ${agent_id} is not in paseo ls"
          return 1
        fi
        ;;
    esac
    if [[ "${turn_seconds}" -ge "${turn_timeout_s}" ]]; then
      log_event "${label}: still '${status}' after ${turn_timeout_s} s"
      return 1
    fi
    sleep 2
  done
}

sampler_start="$(date +%s)"
sample_memory &
sampler_pid=$!
trap 'kill "${sampler_pid}" 2>/dev/null || true' EXIT

start_pid="$(app_pid)"
if [[ -z "${start_pid}" ]]; then
  echo "::error::${APP_ID} is not running after connect."
  exit 1
fi
log_event "start pid=${start_pid} text_delivery=${text_delivery} config: blocks=${blocks} lines=${lines} step_ms=${step_ms} repeats=${repeats} baseline_s=${baseline_s} settle_s=${settle_s} sample_s=${sample_s}"
adb shell dumpsys meminfo "${APP_ID}" >"${out}/meminfo-start.txt" 2>&1 || true
sleep "${baseline_s}"

stream_start_s=$(($(date +%s) - sampler_start))
log_event "spawning the streaming agent"
sent_at="$(date +%s)"
if ! "${cli[@]}" run -d --json "${host[@]}" \
  --provider mock --model ten-second-stream \
  --workspace "${WORKSPACE_ID}" --cwd "${WORKSPACE_DIR}" \
  --title "stream memory" "${prompt}" >"${out}/spawned.json" 2>"${out}/spawn-errors.log"; then
  tail -n 20 "${out}/spawn-errors.log"
  echo "::error::Spawning the mock agent failed; see stream-memory/spawn-errors.log."
  exit 1
fi
agent_id="$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof r.agentId === "string" ? r.agentId : "")' "${out}/spawned.json" 2>/dev/null)"
if [[ -z "${agent_id}" ]]; then
  cat "${out}/spawned.json"
  echo "::error::The run output has no agentId; see stream-memory/spawned.json."
  exit 1
fi
log_event "agent ${agent_id}: opening its chat"
adb shell am start -W -a android.intent.action.VIEW \
  -d "paseo://h/${SERVER_ID}/agent/${agent_id}" "${APP_ID}" >>"${events}" 2>&1 || true
(sleep 10 && adb exec-out screencap -p >"${out}/chat-open.png" 2>/dev/null) &

crashed=false
turn_durations=()
for turn in $(seq 1 "${repeats}"); do
  if [[ "${turn}" -gt 1 ]]; then
    log_event "turn ${turn}: sending the prompt again"
    sent_at="$(date +%s)"
    if ! "${cli[@]}" send --no-wait --json "${host[@]}" "${agent_id}" "${prompt}" \
      >>"${out}/sent.jsonl" 2>>"${out}/spawn-errors.log"; then
      tail -n 20 "${out}/spawn-errors.log"
      echo "::error::Sending turn ${turn} failed; see stream-memory/spawn-errors.log."
      exit 1
    fi
  fi
  wait_for_turn "turn ${turn}" "${sent_at}"
  case $? in
    0) turn_durations+=("${turn_seconds}") ;;
    2)
      crashed=true
      break
      ;;
    *)
      adb exec-out screencap -p >"${out}/turn-failure.png" 2>/dev/null || true
      collect_end_state
      echo "::error::Turn ${turn} did not finish (last status in stream-memory/events.log)."
      exit 1
      ;;
  esac
done

if [[ "${crashed}" == "false" ]]; then
  log_event "all turns finished; settling ${settle_s} s"
  sleep "${settle_s}"
  [[ "$(app_pid)" == "${start_pid}" ]] || crashed=true
fi
if [[ "${crashed}" == "false" ]]; then
  force_js_gc
fi
log_event "end pid=$(app_pid)"

kill "${sampler_pid}" 2>/dev/null || true
collect_end_state
# logcat.txt holds the whole run; `logcat -d` only what the ring buffer kept.
if [[ -f "${ARTIFACTS_DIR}/logcat.txt" ]]; then
  text_tree_warnings="$(grep -c "Text tree size exceeded" "${ARTIFACTS_DIR}/logcat.txt")"
else
  text_tree_warnings="$(adb logcat -d | grep -c "Text tree size exceeded")"
fi
echo "${text_tree_warnings:-0}" >"${out}/text-tree-warnings.txt"

node - "${csv}" "${crashed}" "${stream_start_s}" "${text_tree_warnings:-0}" "${text_delivery}" \
  "${turn_durations[*]:-}" "${prompt}" >>"${GITHUB_STEP_SUMMARY:-/dev/null}" <<'EOF'
const fs = require("fs");
const path = require("path");
const [file, crashed, streamStart, warnings, delivery, durations, prompt] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").trim().split("\n").slice(1)
  .map((line) => line.split(","))
  .filter((cols) => cols[4]);
const mb = (kb) => Math.round(Number(kb) / 1024);
const mean = (values) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : NaN;
const native = rows.map((cols) => mb(cols[4]));
const pss = rows.map((cols) => mb(cols[3]));
const baselineNative = mean(rows.filter((cols) => Number(cols[1]) < Number(streamStart)).map((cols) => mb(cols[4])));
console.log(`### Streaming memory scenario (text delivery: ${delivery})\n`);
console.log(`Prompt: \`${prompt}\`. App process died: **${crashed === "true" ? "yes" : "no"}**. Samples: ${rows.length}.\n`);
console.log(`Turn durations (s): ${durations || "none finished"}. "Text tree size exceeded" warnings: **${warnings}**.\n`);
console.log("| | first 4 samples | last 4 samples | max | max minus baseline |\n|---|---|---|---|---|");
console.log(`| Native heap PSS MB | ${mean(native.slice(0, 4))} | ${mean(native.slice(-4))} | ${Math.max(...native)} | ${Math.max(...native) - baselineNative} |`);
console.log(`| Total PSS MB | ${mean(pss.slice(0, 4))} | ${mean(pss.slice(-4))} | ${Math.max(...pss)} | |`);
console.log(`\nBaseline native heap (mean before the agent spawned): ${baselineNative} MB.`);
const gcNative = (name) => {
  try {
    const m = /^ *Native Heap:\s+(\d+)/m.exec(fs.readFileSync(path.join(path.dirname(file), name), "utf8"));
    return m ? mb(m[1]) : null;
  } catch {
    return null;
  }
};
const before = gcNative("meminfo-before-gc.txt");
const after = gcNative("meminfo-after-gc.txt");
if (before !== null && after !== null) {
  console.log(`\nForced JS GC at the end: native heap ${before} MB -> ${after} MB (${after - before} MB).`);
}
EOF

if [[ "${crashed}" == "true" ]]; then
  echo "::error::${APP_ID} died during the streaming memory scenario. See stream-memory/exit-info.txt and native-crashes.txt."
  exit 1
fi
echo "Streaming memory scenario finished; the app stayed up."
