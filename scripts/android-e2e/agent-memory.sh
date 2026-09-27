#!/usr/bin/env bash
# Many-agent memory scenario for the Android E2E workflow. Runs inside
# run-on-emulator.sh after the app is connected and showing the fixture
# workspace. Spawns mock agents in bursts, each spawning provider subagents
# that stream large tool results, and samples the app's memory throughout.
# It measures, it does not assert: the job fails only when the app process
# dies or setup breaks.
#
# Needs: APP_ID, DAEMON_PORT, WORKSPACE_ID, WORKSPACE_DIR, ARTIFACTS_DIR,
# DAEMON_SRC_DIR. MEMORY_CONFIG overrides the defaults below as
# space-separated key=value pairs, e.g. "batches=6 batch_size=5".
set -uo pipefail

: "${APP_ID:?}" "${DAEMON_PORT:?}" "${WORKSPACE_ID:?}" "${WORKSPACE_DIR:?}"
: "${ARTIFACTS_DIR:?}" "${DAEMON_SRC_DIR:?}"

batches=10          # bursts of agents
batch_size=10       # agents per burst
batch_gap_s=90      # wait between bursts
subagents=3         # provider subagents per agent
tool_results=20     # tool results per subagent
tool_result_kb=32   # size of each tool result
step_ms=500         # delay between subagent steps
baseline_s=60       # idle sampling before the first burst
settle_s=180        # sampling after the last burst
sample_s=15         # meminfo interval
for pair in ${MEMORY_CONFIG:-}; do
  key="${pair%%=*}"
  value="${pair#*=}"
  case "${key}" in
    batches | batch_size | batch_gap_s | subagents | tool_results | tool_result_kb | step_ms | baseline_s | settle_s | sample_s)
      [[ "${value}" =~ ^[0-9]+$ ]] || {
        echo "::error::MEMORY_CONFIG ${key} must be a whole number, got '${value}'."
        exit 1
      }
      printf -v "${key}" '%s' "${value}"
      ;;
    *)
      echo "::error::Unknown MEMORY_CONFIG key '${key}'."
      exit 1
      ;;
  esac
done

out="${ARTIFACTS_DIR}/agent-memory"
mkdir -p "${out}"
csv="${out}/meminfo.csv"
events="${out}/events.log"
cli=(node "${DAEMON_SRC_DIR}/packages/cli/bin/paseo")
host=(--host "127.0.0.1:${DAEMON_PORT}")
prompt="Emit ${subagents} synthetic subagents with ${tool_results} tool results of ${tool_result_kb} KB every ${step_ms} ms."

log_event() {
  echo "$(date -Iseconds) $*" | tee -a "${events}"
}

# Same columns as the phone sampler (~/apks/leak-ab-sampler.sh), plus the
# daemon's agent count, so runs on the phone and the emulator compare directly.
sample_memory() {
  echo "time,elapsed_s,pid,total_pss_kb,native_heap_pss_kb,java_heap_pss_kb,graphics_pss_kb,native_heap_alloc_kb,unknown_pss_kb,total_rss_kb,daemon_agents,views" >"${csv}"
  local start info pid agents
  start="$(date +%s)"
  while :; do
    info="$(adb shell dumpsys meminfo "${APP_ID}" 2>/dev/null)"
    agents="$("${cli[@]}" ls -g --json "${host[@]}" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).length)}catch{console.log("")}})')"
    pid="$(printf '%s\n' "${info}" | sed -n 's/.*MEMINFO in pid \([0-9]*\).*/\1/p' | head -n 1)"
    if [[ -z "${pid}" ]]; then
      echo "$(date -Iseconds),$(($(date +%s) - start)),none,,,,,,,,${agents}," >>"${csv}"
    else
      printf '%s\n' "${info}" | awk -v t="$(date -Iseconds)" -v e="$(($(date +%s) - start))" -v pid="${pid}" -v agents="${agents}" '
        /^ *TOTAL PSS:/ { total = $3 }
        /TOTAL RSS:/ { for (i = 1; i <= NF; i++) if ($i == "RSS:") rss = $(i + 1) }
        /^ *Native Heap:/ { native = $3 }
        /^ *Java Heap:/ { java = $3 }
        /^ *Graphics:/ { graphics = $2 }
        /^ *Native Heap / && NF >= 9 { alloc = $(NF - 1) }
        /^ *Unknown / { unknown = $2 }
        /Views:/ { for (i = 1; i <= NF; i++) if ($i == "Views:") views = $(i + 1) }
        END { print t "," e "," pid "," total "," native "," java "," graphics "," alloc "," unknown "," rss "," agents "," views }
      ' >>"${csv}"
    fi
    sleep "${sample_s}"
  done
}

app_pid() {
  adb shell pidof "${APP_ID}" 2>/dev/null | tr -d '\r'
}

sample_memory &
sampler_pid=$!
trap 'kill "${sampler_pid}" 2>/dev/null || true' EXIT

start_pid="$(app_pid)"
if [[ -z "${start_pid}" ]]; then
  echo "::error::${APP_ID} is not running after connect."
  exit 1
fi
log_event "start pid=${start_pid} config: batches=${batches} batch_size=${batch_size} batch_gap_s=${batch_gap_s} subagents=${subagents} tool_results=${tool_results} tool_result_kb=${tool_result_kb} step_ms=${step_ms}"
adb shell dumpsys meminfo "${APP_ID}" >"${out}/meminfo-start.txt" 2>&1 || true
sleep "${baseline_s}"

crashed=false
for batch in $(seq 1 "${batches}"); do
  log_event "batch ${batch}: spawning ${batch_size} agents"
  for index in $(seq 1 "${batch_size}"); do
    "${cli[@]}" run -d --json "${host[@]}" \
      --provider mock --model ten-second-stream \
      --workspace "${WORKSPACE_ID}" --cwd "${WORKSPACE_DIR}" \
      --title "memory ${batch}.${index}" "${prompt}" >>"${out}/spawned.jsonl" 2>>"${out}/spawn-errors.log" || {
      # Without agents the run measures an idle app; stop instead of reporting that.
      log_event "batch ${batch}: spawn ${index} failed"
      tail -n 20 "${out}/spawn-errors.log"
      echo "::error::Spawning mock agents failed; see agent-memory/spawn-errors.log."
      exit 1
    }
  done
  sleep "${batch_gap_s}"
  pid="$(app_pid)"
  if [[ "${pid}" != "${start_pid}" ]]; then
    log_event "app process changed after batch ${batch}: ${start_pid} -> ${pid:-none}"
    crashed=true
    break
  fi
done

if [[ "${crashed}" == "false" ]]; then
  log_event "all batches spawned; settling ${settle_s} s"
  sleep "${settle_s}"
  pid="$(app_pid)"
  [[ "${pid}" == "${start_pid}" ]] || crashed=true
fi

# React Native forces a JS garbage collection on TRIM_MEMORY_RUNNING_CRITICAL. Native memory that
# drops after it was held only by unreachable JS wrappers (stale Fabric shadow nodes); what stays
# is retained. Android 14+ never sends this level to a foreground app on its own.
if [[ "${crashed}" == "false" ]]; then
  adb shell dumpsys meminfo "${APP_ID}" >"${out}/meminfo-before-gc.txt" 2>&1 || true
  log_event "forcing a JS GC with send-trim-memory RUNNING_CRITICAL"
  adb shell am send-trim-memory "${APP_ID}" RUNNING_CRITICAL >>"${events}" 2>&1 || true
  sleep 10
  adb shell dumpsys meminfo "${APP_ID}" >"${out}/meminfo-after-gc.txt" 2>&1 || true
  sleep $((sample_s * 2))
fi
log_event "end pid=${pid:-none}"

kill "${sampler_pid}" 2>/dev/null || true
adb shell dumpsys meminfo "${APP_ID}" >"${out}/meminfo-end.txt" 2>&1 || true
adb shell dumpsys activity exit-info "${APP_ID}" >"${out}/exit-info.txt" 2>&1 || true
adb shell dumpsys dropbox --print data_app_native_crash >"${out}/native-crashes.txt" 2>&1 || true
adb shell dumpsys dropbox --print data_app_crash >"${out}/java-crashes.txt" 2>&1 || true
adb exec-out screencap -p >"${out}/end-screen.png" 2>/dev/null || true

node - "${csv}" "${crashed}" >>"${GITHUB_STEP_SUMMARY:-/dev/null}" <<'EOF'
const [file, crashed] = process.argv.slice(2);
const rows = require("fs").readFileSync(file, "utf8").trim().split("\n").slice(1)
  .map((line) => line.split(","))
  .filter((cols) => cols[4]);
const mb = (kb) => Math.round(Number(kb) / 1024);
const native = rows.map((cols) => mb(cols[4]));
const pss = rows.map((cols) => mb(cols[3]));
const first = (values) => values.slice(0, 4).reduce((a, b) => a + b, 0) / Math.min(4, values.length);
const last = (values) => values.slice(-4).reduce((a, b) => a + b, 0) / Math.min(4, values.length);
console.log("### Many-agent memory scenario\n");
console.log(`App process died: **${crashed === "true" ? "yes" : "no"}**. Samples: ${rows.length}. Daemon agents at the end: ${rows.at(-1)?.[10] ?? "?"}.\n`);
console.log("| | first min | last min | max |\n|---|---|---|---|");
console.log(`| Native heap PSS MB | ${Math.round(first(native))} | ${Math.round(last(native))} | ${Math.max(...native)} |`);
console.log(`| Total PSS MB | ${Math.round(first(pss))} | ${Math.round(last(pss))} | ${Math.max(...pss)} |`);
const gcNative = (name) => { try { const m = /^ *Native Heap:\s+(\d+)/m.exec(require("fs").readFileSync(require("path").join(require("path").dirname(file), name), "utf8")); return m ? mb(m[1]) : null; } catch { return null; } };
const before = gcNative("meminfo-before-gc.txt"), after = gcNative("meminfo-after-gc.txt");
if (before !== null && after !== null) console.log(`\nForced JS GC at the end: native heap ${before} MB -> ${after} MB.`);
EOF

if [[ "${crashed}" == "true" ]]; then
  echo "::error::${APP_ID} died during the many-agent memory scenario. See agent-memory/exit-info.txt and native-crashes.txt."
  exit 1
fi
echo "Many-agent memory scenario finished; the app stayed up."
