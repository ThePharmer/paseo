# Helpers shared by the memory scenarios (agent-memory.sh, stream-memory.sh).
# Source it; it defines functions only. They read these globals, which the
# scenario sets first: APP_ID, out (the scenario's artifact dir), csv, events,
# cli, host, sample_s.

# parse_memory_config <key>...: applies MEMORY_CONFIG's space-separated
# key=value pairs to the variables of the same name. Only the listed keys are
# accepted, and only whole numbers.
parse_memory_config() {
  local pair key value
  for pair in ${MEMORY_CONFIG:-}; do
    key="${pair%%=*}"
    value="${pair#*=}"
    if [[ " $* " != *" ${key} "* ]]; then
      echo "::error::Unknown MEMORY_CONFIG key '${key}'. Known keys: $*."
      return 1
    fi
    if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
      echo "::error::MEMORY_CONFIG ${key} must be a whole number, got '${value}'."
      return 1
    fi
    printf -v "${key}" '%s' "${value}"
  done
}

log_event() {
  echo "$(date -Iseconds) $*" | tee -a "${events}"
}

app_pid() {
  adb shell pidof "${APP_ID}" 2>/dev/null | tr -d '\r'
}

# Same columns as the phone sampler (~/apks/leak-ab-sampler.sh), plus the
# daemon's agent count, so runs on the phone and the emulator compare directly.
# Runs until killed; start it in the background.
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

# React Native forces a JS garbage collection on TRIM_MEMORY_RUNNING_CRITICAL. Native memory that
# drops after it was held only by unreachable JS wrappers (stale Fabric shadow nodes); what stays
# is retained. Android 14+ never sends this level to a foreground app on its own.
force_js_gc() {
  adb shell dumpsys meminfo "${APP_ID}" >"${out}/meminfo-before-gc.txt" 2>&1 || true
  log_event "forcing a JS GC with send-trim-memory RUNNING_CRITICAL"
  adb shell am send-trim-memory "${APP_ID}" RUNNING_CRITICAL >>"${events}" 2>&1 || true
  sleep 10
  adb shell dumpsys meminfo "${APP_ID}" >"${out}/meminfo-after-gc.txt" 2>&1 || true
  sleep $((sample_s * 2))
}

# Final meminfo, the app's exit reasons, crash reports and the screen.
collect_end_state() {
  adb shell dumpsys meminfo "${APP_ID}" >"${out}/meminfo-end.txt" 2>&1 || true
  adb shell dumpsys activity exit-info "${APP_ID}" >"${out}/exit-info.txt" 2>&1 || true
  adb shell dumpsys dropbox --print data_app_native_crash >"${out}/native-crashes.txt" 2>&1 || true
  adb shell dumpsys dropbox --print data_app_crash >"${out}/java-crashes.txt" 2>&1 || true
  adb exec-out screencap -p >"${out}/end-screen.png" 2>/dev/null || true
}
