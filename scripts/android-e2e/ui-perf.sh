#!/usr/bin/env bash
# UI-thread work scenario for the Android E2E workflow. Runs inside
# run-on-emulator.sh after the app is connected, with the system animation
# scales at 1 so Reanimated animates (run-on-emulator.sh sets them for this
# scenario). The emulator renders in software, so frame times mean nothing
# here; this records counts that do not depend on the GPU:
#
#   quiet   no agent running, no touch
#   idle    a mock agent running at one token a second, its chat open (the
#           status ring in the header is on screen), no touch
#   stream  a fresh mock agent streaming a code-heavy answer at a fixed rate
#           into its open chat
#
# Each window records main (UI) thread and JS thread CPU from
# /proc/<pid>/task/*/stat, frames rendered (dumpsys gfxinfo), Choreographer
# frames and Fabric mount batches from an app atrace, and, where the kernel
# allows uprobes, every facebook::react::ShadowTree::commit call split by
# thread: commits on the main thread come from Reanimated (and native state
# updates), commits on the JS thread from React.
#
# Then the tap test: Settings > Switch host sheet (the #32 sheet), tap the
# trigger to open it and press the sheet's "Add host" row at fixed delays.
# The row's action opens the add-host method modal; a dropped press leaves the
# sheet open. `hold` presses send move events between down and up, like a
# finger, which is what makes Pressable re-check its press rectangle. The
# control presses the trigger, which never moves.
#
# Everything repeats `repeats` times. It measures, it does not assert: the job
# fails only when the app process dies or setup breaks.
#
# Needs: APP_ID, APK_PATH, DAEMON_PORT, SERVER_ID, WORKSPACE_ID, WORKSPACE_DIR,
# ARTIFACTS_DIR, DAEMON_SRC_DIR. MEMORY_CONFIG overrides the defaults below as
# space-separated key=value pairs, e.g. "repeats=1 stream_s=30 hold_tries=5".
set -uo pipefail

: "${APP_ID:?}" "${APK_PATH:?}" "${DAEMON_PORT:?}" "${SERVER_ID:?}" "${WORKSPACE_ID:?}"
: "${WORKSPACE_DIR:?}" "${ARTIFACTS_DIR:?}" "${DAEMON_SRC_DIR:?}"

repeats=3
quiet_s=20           # window with no agent running
idle_s=20            # window with the slow agent's chat open
idle_step_ms=1000    # the slow agent's delay between tokens
stream_s=60          # window while the agent streams
stream_step_ms=20    # the streaming agent's delay between tokens
stream_blocks=40     # code blocks in the streamed answer (more than stream_s needs)
stream_warmup_s=8    # from opening the chat to the start of the stream window
hold_tries=20        # sheet-row presses with moves, per repeat
tap_tries=10         # sheet-row plain taps, per repeat
control_tries=10     # trigger presses, per repeat
settle_ms=1500       # from a press to the UI dump that classifies it
# shellcheck source=memory-common.sh
source "$(dirname "$0")/memory-common.sh"
parse_memory_config repeats quiet_s idle_s idle_step_ms stream_s stream_step_ms stream_blocks \
  stream_warmup_s hold_tries tap_tries control_tries settle_ms || exit 1
if [[ "${repeats}" -lt 1 || "${quiet_s}" -lt 1 || "${idle_s}" -lt 1 || "${stream_s}" -lt 1 ]]; then
  echo "::error::MEMORY_CONFIG repeats and the window lengths must be at least 1."
  exit 1
fi
# Delays from the trigger tap to the row press, cycled over the tries. The
# `input` command itself takes a few hundred ms to start, so the measured gap
# (gap_ms in taps.csv) is what to read; the open animation runs ~300-500 ms.
# A press within ~100 ms of the trigger tap lands before the sheet exists and
# reads as dropped (the sheet opens afterwards and stays open).
delays_ms=(100 250 400 600 1500)

out="${ARTIFACTS_DIR}/ui-perf"
mkdir -p "${out}/windows" "${out}/taps"
events="${out}/events.log"
windows_csv="${out}/windows.csv"
taps_csv="${out}/taps.csv"
cli=(node "${DAEMON_SRC_DIR}/packages/cli/bin/paseo")
host=(--host "127.0.0.1:${DAEMON_PORT}")
tools=(node "$(dirname "$0")/ui-perf-tools.mjs")
problems=()

echo "phase,repeat,seconds,elapsed_s,pid,main_cpu_ms_s,js_cpu_ms_s,render_cpu_ms_s,process_cpu_ms_s,frames,frames_s,doframe_s,mount_batches_s,update_props_groups_s,mount_dispatch_s,commit_main_s,commit_js_s,commit_other_s,execute_mount_s,sync_view_update_s,trace_sections,js_threads" >"${windows_csv}"
echo "repeat,target,style,delay_ms,gap_ms,outcome" >"${taps_csv}"

now_ms() { date +%s%3N; }

# ---------------------------------------------------------------------------
# Root and commit probes

root_prefix=""
has_root=false
if [[ "$(adb shell id -u 2>/dev/null | tr -d '\r')" == "0" ]]; then
  has_root=true
elif [[ "$(adb shell su 0 id -u 2>/dev/null | tr -d '\r')" == "0" ]]; then
  has_root=true
  root_prefix="su 0"
fi

# Runs a shell script on the device as root. Scripts go through a file so no
# quoting survives two shells.
run_as_root() {
  local script="$1" remote=/data/local/tmp/ui-perf-root.sh
  printf '%s\n' "${script}" >"${out}/.root.sh"
  adb push "${out}/.root.sh" "${remote}" >/dev/null 2>&1 || return 1
  # shellcheck disable=SC2086
  adb shell ${root_prefix} sh "${remote}"
}

tracefs=""
uprobes="unavailable"
commit_symbol='_ZNK8facebook5react10ShadowTree6commitERKNSt6__ndk18functionIFNS2_10shared_ptrINS0_14RootShadowNodeEEERKS5_EEERKNS0_23ShadowTreeCommitOptionsE'
mount_symbol='_ZN8facebook5react21FabricMountingManager12executeMountERKNS0_19MountingTransactionE'
sync_symbol='_ZN8facebook5react21FabricMountingManager33synchronouslyUpdateViewOnUIThreadEiRKN5folly7dynamicE'

# Places uprobes on three exported libreactnative.so functions. The library is
# mapped straight from base.apk when the APK stores it uncompressed, so the
# probe goes on the APK at the library's offset inside it; an extracted
# library gets the probe on its own file.
setup_uprobes() {
  local pid="$1" maps lib_path offsets apk_path
  if [[ "${has_root}" != "true" ]]; then
    uprobes="unavailable (no root shell)"
    return 1
  fi
  maps="$(adb shell ${root_prefix} cat "/proc/${pid}/maps" 2>/dev/null | tr -d '\r')"
  printf '%s\n' "${maps}" >"${out}/maps.txt"
  "${tools[@]}" uprobe-offsets "${APK_PATH}" lib/x86_64/libreactnative.so \
    "${commit_symbol}" "${mount_symbol}" "${sync_symbol}" >"${out}/uprobe-offsets.txt" 2>>"${events}" || {
    uprobes="unavailable (symbols not found)"
    return 1
  }
  lib_path="$(printf '%s\n' "${maps}" | awk '/libreactnative\.so$/ { print $NF; exit }')"
  if [[ -n "${lib_path}" ]]; then
    offsets="$(awk '{ print $3 }' "${out}/uprobe-offsets.txt" | paste -sd' ')"
    apk_path="${lib_path}"
  else
    apk_path="$(printf '%s\n' "${maps}" | awk '/\/base\.apk$/ && $2 ~ /x/ { print $NF; exit }')"
    offsets="$(awk '{ print $2 }' "${out}/uprobe-offsets.txt" | paste -sd' ')"
    if [[ -z "${apk_path}" || "${offsets}" == *"-0x"* ]]; then
      uprobes="unavailable (libreactnative.so is neither extracted nor mapped from base.apk)"
      return 1
    fi
  fi
  read -r commit_off mount_off sync_off <<<"${offsets}"
  local result
  result="$(run_as_root "
T=/sys/kernel/tracing
[ -e \$T/uprobe_events ] || T=/sys/kernel/debug/tracing
[ -e \$T/uprobe_events ] || { echo 'no uprobe_events in tracefs'; exit 3; }
echo '-:paseo/commit' >> \$T/uprobe_events 2>/dev/null
echo '-:paseo/mount' >> \$T/uprobe_events 2>/dev/null
echo '-:paseo/syncupd' >> \$T/uprobe_events 2>/dev/null
echo 'p:paseo/commit ${apk_path}:${commit_off}' >> \$T/uprobe_events || { echo 'adding the commit probe failed'; exit 4; }
echo 'p:paseo/mount ${apk_path}:${mount_off}' >> \$T/uprobe_events || { echo 'adding the mount probe failed'; exit 4; }
echo 'p:paseo/syncupd ${apk_path}:${sync_off}' >> \$T/uprobe_events || { echo 'adding the sync update probe failed'; exit 4; }
mkdir -p \$T/instances/paseo_ui || { echo 'no tracefs instances'; exit 5; }
echo 0 > \$T/instances/paseo_ui/tracing_on
echo 8192 > \$T/instances/paseo_ui/buffer_size_kb
echo 1 > \$T/instances/paseo_ui/events/paseo/enable || { echo 'enabling the probes failed'; exit 6; }
echo \"ok \$T\"
" 2>&1 | tr -d '\r')"
  echo "uprobe setup: ${result}" >>"${events}"
  if [[ "${result}" == *"ok /"* ]]; then
    tracefs="$(printf '%s\n' "${result}" | awk '/^ok \// { print $2 }' | tail -n 1)"
    uprobes="on (${apk_path##*/}: commit ${commit_off}, executeMount ${mount_off}, synchronouslyUpdateViewOnUIThread ${sync_off})"
    return 0
  fi
  uprobes="unavailable (${result//$'\n'/; })"
  return 1
}

uprobe_start() {
  [[ -n "${tracefs}" ]] || return 0
  run_as_root "echo > ${tracefs}/instances/paseo_ui/trace; echo 1 > ${tracefs}/instances/paseo_ui/tracing_on" >/dev/null 2>&1
}

uprobe_stop() {
  [[ -n "${tracefs}" ]] || return 0
  run_as_root "echo 0 > ${tracefs}/instances/paseo_ui/tracing_on" >/dev/null 2>&1
}

uprobe_collect() {
  local dest="$1"
  [[ -n "${tracefs}" ]] || return 0
  run_as_root "cat ${tracefs}/instances/paseo_ui/trace > /data/local/tmp/ui-perf-uprobes.txt; chmod 644 /data/local/tmp/ui-perf-uprobes.txt" >/dev/null 2>&1
  adb pull /data/local/tmp/ui-perf-uprobes.txt "${dest}" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Measurement windows

task_stats() {
  adb shell "cat /proc/$1/task/*/stat" 2>/dev/null | tr -d '\r'
}

json_field() {
  node -e 'const o = JSON.parse(process.argv[1] || "{}"); const v = o[process.argv[2]]; process.stdout.write(v === undefined ? "" : String(v));' "$1" "$2"
}

# measure_window <phase> <repeat> <seconds>: no input during the window.
measure_window() {
  local phase="$1" repeat="$2" seconds="$3" pid dir t0 t1 elapsed
  pid="$(app_pid)"
  if [[ -z "${pid}" || "${pid}" != "${start_pid}" ]]; then
    log_event "${phase} ${repeat}: app process changed (${start_pid} -> ${pid:-none})"
    crashed=true
    return 1
  fi
  dir="${out}/windows/${phase}-${repeat}"
  mkdir -p "${dir}"
  # CPU, frames and probe hits all cover t0..t1: the atrace window plus the
  # probe toggles around it (a few hundred ms). Section counts cover the atrace
  # window alone.
  adb shell dumpsys gfxinfo "${APP_ID}" reset >/dev/null 2>&1
  task_stats "${pid}" >"${dir}/tasks-before.txt"
  t0="$(now_ms)"
  uprobe_start
  # atrace blocks for the window. `view` gives Choreographer frames; -a turns
  # on the app's own sections, which include React Native's Fabric mounting.
  adb shell atrace -a "${APP_ID}" -b 16384 -t "${seconds}" -o /data/local/tmp/ui-perf.atrace view >"${dir}/atrace.log" 2>&1
  uprobe_stop
  t1="$(now_ms)"
  task_stats "${pid}" >"${dir}/tasks-after.txt"
  adb shell dumpsys gfxinfo "${APP_ID}" >"${dir}/gfxinfo.txt" 2>&1
  uprobe_collect "${dir}/uprobes.txt"
  adb pull /data/local/tmp/ui-perf.atrace "${dir}/atrace.txt" >/dev/null 2>&1
  elapsed="$(awk -v a="${t0}" -v b="${t1}" 'BEGIN { printf "%.2f", (b - a) / 1000 }')"

  local cpu atrace probes frames frames_s
  cpu="$("${tools[@]}" task-cpu "${dir}/tasks-before.txt" "${dir}/tasks-after.txt" "${pid}" "${elapsed}")"
  atrace="$("${tools[@]}" atrace "${dir}/atrace.txt" "${pid}" "${seconds}" "${dir}/sections.tsv" 2>/dev/null || echo '{}')"
  probes='{}'
  if [[ -n "${tracefs}" ]]; then
    probes="$("${tools[@]}" uprobes "${dir}/uprobes.txt" "${dir}/tasks-after.txt" "${pid}" "${elapsed}" || echo '{}')"
  fi
  frames="$(awk '/Total frames rendered/ { print $4; exit }' "${dir}/gfxinfo.txt")"
  frames_s="$(awk -v f="${frames:-0}" -v e="${elapsed}" 'BEGIN { printf "%.1f", f / e }')"
  echo "${cpu}" >"${dir}/cpu.json"
  echo "${atrace}" >"${dir}/atrace.json"
  echo "${probes}" >"${dir}/uprobes.json"

  local row=("${phase}" "${repeat}" "${seconds}" "${elapsed}" "${pid}")
  for key in main_cpu_ms_s js_cpu_ms_s render_cpu_ms_s process_cpu_ms_s; do row+=("$(json_field "${cpu}" "${key}")"); done
  row+=("${frames}" "${frames_s}")
  for key in doframe_s mount_batches_s update_props_groups_s mount_dispatch_s; do row+=("$(json_field "${atrace}" "${key}")"); done
  for key in commit_main_s commit_js_s commit_other_s mount_main_s syncupd_main_s; do row+=("$(json_field "${probes}" "${key}")"); done
  row+=("$(json_field "${atrace}" trace_sections)" "$(json_field "${cpu}" js_thread_names)")
  (
    IFS=,
    echo "${row[*]}"
  ) >>"${windows_csv}"
  log_event "${phase} ${repeat}: $(tail -n 1 "${windows_csv}") | top: $(json_field "${cpu}" top_threads)"
}

# ---------------------------------------------------------------------------
# Agents

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
  ' "$1"
}

# spawn_and_open <title> <prompt>: sets agent_id and opens its chat.
spawn_and_open() {
  local title="$1" prompt="$2" file="${out}/spawned-$(date +%s%N).json"
  if ! "${cli[@]}" run -d --json "${host[@]}" \
    --provider mock --model ten-second-stream \
    --workspace "${WORKSPACE_ID}" --cwd "${WORKSPACE_DIR}" \
    --title "${title}" "${prompt}" >"${file}" 2>>"${out}/spawn-errors.log"; then
    tail -n 20 "${out}/spawn-errors.log"
    echo "::error::Spawning the mock agent failed; see ui-perf/spawn-errors.log."
    return 1
  fi
  agent_id="$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof r.agentId === "string" ? r.agentId : "")' "${file}" 2>/dev/null)"
  if [[ -z "${agent_id}" ]]; then
    echo "::error::The run output has no agentId; see ${file}."
    return 1
  fi
  log_event "agent ${agent_id} (${title}): opening its chat"
  adb shell am start -W -a android.intent.action.VIEW \
    -d "paseo://h/${SERVER_ID}/agent/${agent_id}" "${APP_ID}" >>"${events}" 2>&1 || true
}

stop_agent() {
  "${cli[@]}" stop --json "${host[@]}" "$1" >>"${events}" 2>&1 || log_event "stopping $1 failed"
}

# ---------------------------------------------------------------------------
# UI dumps and presses for the tap test

screen_w=1080
screen_h=2400
read -r screen_w screen_h < <(adb shell wm size 2>/dev/null | tr -d '\r' | awk -F'[ x]' '/size/ { w = $(NF-1); h = $NF } END { print w, h }')

dump_ui() {
  local dest="$1"
  for _ in 1 2 3; do
    if timeout 20 adb shell uiautomator dump /sdcard/ui-perf.xml >/dev/null 2>&1; then
      adb exec-out cat /sdcard/ui-perf.xml >"${dest}" 2>/dev/null
      [[ -s "${dest}" ]] && return 0
    fi
    sleep 0.5
  done
  return 1
}

sheet_row_id="settings-add-host"
trigger_id="settings-host-picker"
modal_id="add-host-method-modal"

open_settings() {
  adb shell am start -W -a android.intent.action.VIEW -d "paseo://settings" "${APP_ID}" >>"${events}" 2>&1 || true
  sleep 3
}

# Brings the app back to the Settings root with no sheet or modal open.
ensure_settings_root() {
  local xml="${out}/taps/state.xml"
  for attempt in 1 2 3 4 5; do
    if ! dump_ui "${xml}"; then
      sleep 1
      continue
    fi
    if "${tools[@]}" has-id "${xml}" "${modal_id}" "${sheet_row_id}"; then
      adb shell input keyevent KEYCODE_BACK
      sleep 1.2
    elif "${tools[@]}" has-id "${xml}" "${trigger_id}"; then
      return 0
    elif [[ "${attempt}" -ge 2 ]]; then
      open_settings
    else
      adb shell input keyevent KEYCODE_BACK
      sleep 1.2
    fi
  done
  return 1
}

# press <style> <x> <y> as a device-side shell fragment.
press_cmd() {
  case "$1" in
    tap) echo "input tap $2 $3" ;;
    hold) echo "input swipe $2 $3 $2 $3 100" ;;
  esac
}

hold_ms() { [[ "$1" == "hold" ]] && echo 100 || echo 0; }

classify() {
  local xml="$1"
  if "${tools[@]}" has-id "${xml}" "${modal_id}"; then
    echo acted
  elif "${tools[@]}" has-id "${xml}" "${sheet_row_id}"; then
    echo dropped
  else
    echo missed
  fi
}

# One sheet-row try: open the sheet with a plain tap on the trigger, wait,
# press the row, classify from a UI dump.
try_sheet_row() {
  local repeat="$1" index="$2" style="$3" delay_ms="$4" delay_s times gap outcome xml
  delay_s="$(awk -v d="${delay_ms}" 'BEGIN { printf "%.3f", d / 1000 }')"
  # One device-side shell, so adb round trips do not stretch the delay.
  times="$(adb shell "b=\$(cut -d' ' -f1 /proc/uptime); input tap ${trigger_x} ${trigger_y}; c=\$(cut -d' ' -f1 /proc/uptime); sleep ${delay_s}; $(press_cmd "${style}" "${row_x}" "${row_y}"); d=\$(cut -d' ' -f1 /proc/uptime); echo \$b \$c \$d" | tr -d '\r')"
  # The row's down event lands at the end of its `input` command, minus the hold.
  gap="$(awk -v t="${times}" -v h="$(hold_ms "${style}")" 'BEGIN { split(t, a, " "); printf "%d", (a[3] - a[2]) * 1000 - h }')"
  sleep "$(awk -v s="${settle_ms}" 'BEGIN { printf "%.3f", s / 1000 }')"
  xml="${out}/taps/row-${repeat}-${style}-${index}.xml"
  if dump_ui "${xml}"; then
    outcome="$(classify "${xml}")"
  else
    outcome="no-dump"
  fi
  echo "${repeat},sheet-row,${style},${delay_ms},${gap},${outcome}" >>"${taps_csv}"
  [[ "${outcome}" == "acted" ]] && rm -f "${xml}"
  ensure_settings_root || log_event "taps: could not return to the Settings root after ${style} try ${index}"
}

# One control try: press the trigger, which never moves; the sheet opening is the action.
try_control() {
  local repeat="$1" index="$2" style="$3" outcome xml
  adb shell "$(press_cmd "${style}" "${trigger_x}" "${trigger_y}")"
  sleep "$(awk -v s="${settle_ms}" 'BEGIN { printf "%.3f", s / 1000 }')"
  xml="${out}/taps/control-${repeat}-${style}-${index}.xml"
  if dump_ui "${xml}"; then
    if "${tools[@]}" has-id "${xml}" "${sheet_row_id}"; then
      outcome=acted
      rm -f "${xml}"
    elif "${tools[@]}" has-id "${xml}" "${trigger_id}"; then
      outcome=dropped
    else
      outcome=missed
    fi
  else
    outcome=no-dump
  fi
  echo "${repeat},trigger,${style},0,0,${outcome}" >>"${taps_csv}"
  ensure_settings_root || log_event "taps: could not return to the Settings root after control try ${index}"
}

calibrate_taps() {
  open_settings
  if ! ensure_settings_root; then
    adb exec-out screencap -p >"${out}/taps/calibration-failed.png" 2>/dev/null
    cp "${out}/taps/state.xml" "${out}/taps/calibration-failed.xml" 2>/dev/null
    return 1
  fi
  cp "${out}/taps/state.xml" "${out}/taps/settings-root.xml"
  if ! read -r trigger_x trigger_y < <("${tools[@]}" bounds "${out}/taps/settings-root.xml" "${trigger_id}"); then
    log_event "taps: Settings shows no ${trigger_id}"
    return 1
  fi
  adb shell input tap "${trigger_x}" "${trigger_y}"
  sleep 2.5
  dump_ui "${out}/taps/sheet-open.xml"
  adb exec-out screencap -p >"${out}/taps/sheet-open.png" 2>/dev/null
  if ! read -r row_x row_y < <("${tools[@]}" bounds "${out}/taps/sheet-open.xml" "${sheet_row_id}"); then
    log_event "taps: the Switch host sheet did not show ${sheet_row_id}"
    return 1
  fi
  log_event "taps: trigger at ${trigger_x},${trigger_y}; Add host row at ${row_x},${row_y}; screen ${screen_w}x${screen_h}"
  ensure_settings_root
}

# ---------------------------------------------------------------------------
# Run

start_pid="$(app_pid)"
if [[ -z "${start_pid}" ]]; then
  echo "::error::${APP_ID} is not running after connect."
  exit 1
fi
crashed=false
adb shell svc power stayon true >/dev/null 2>&1 || true
adb shell settings put system screen_off_timeout 1800000 >/dev/null 2>&1 || true

apk_flags="$("${tools[@]}" apk-flags "${APK_PATH}" 2>>"${events}" || echo '{}')"
echo "${apk_flags}" >"${out}/reanimated-flags.json"
sync_ui_props="$(json_field "${apk_flags}" ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS)"
{
  echo "ro.build.type=$(adb shell getprop ro.build.type | tr -d '\r')"
  echo "ro.debuggable=$(adb shell getprop ro.debuggable | tr -d '\r')"
  echo "animator_duration_scale=$(adb shell settings get global animator_duration_scale | tr -d '\r')"
  echo "transition_animation_scale=$(adb shell settings get global transition_animation_scale | tr -d '\r')"
  echo "window_animation_scale=$(adb shell settings get global window_animation_scale | tr -d '\r')"
  echo "wm_size=$(adb shell wm size | tr -d '\r' | paste -sd' ')"
  echo "wm_density=$(adb shell wm density | tr -d '\r' | paste -sd' ')"
  echo "root=${has_root} ${root_prefix}"
} >"${out}/device.txt"
setup_uprobes "${start_pid}" || true
log_event "start pid=${start_pid} sync_ui_props=${sync_ui_props:-?} uprobes=${uprobes} config: repeats=${repeats} quiet_s=${quiet_s} idle_s=${idle_s} idle_step_ms=${idle_step_ms} stream_s=${stream_s} stream_step_ms=${stream_step_ms} hold_tries=${hold_tries} tap_tries=${tap_tries} control_tries=${control_tries}"

# quiet: the connected workspace, nothing running.
sleep 5
adb exec-out screencap -p >"${out}/quiet.png" 2>/dev/null
for repeat in $(seq 1 "${repeats}"); do
  measure_window quiet "${repeat}" "${quiet_s}" || break
  sleep 2
done

# idle: one slow agent running, its chat open, no touch.
if [[ "${crashed}" == "false" ]]; then
  spawn_and_open "ui-perf idle" "Stream 200 code blocks of 40 lines every ${idle_step_ms} ms." || exit 1
  idle_agent="${agent_id}"
  sleep 15
  adb exec-out screencap -p >"${out}/idle-chat.png" 2>/dev/null
  log_event "idle agent status: $(agent_status "${idle_agent}")"
  for repeat in $(seq 1 "${repeats}"); do
    measure_window idle "${repeat}" "${idle_s}" || break
    sleep 3
  done
  log_event "idle agent status after the windows: $(agent_status "${idle_agent}")"
  stop_agent "${idle_agent}"
  sleep 3
fi

# stream: a fresh agent per repeat, so every window starts from the same chat.
if [[ "${crashed}" == "false" ]]; then
  for repeat in $(seq 1 "${repeats}"); do
    spawn_and_open "ui-perf stream ${repeat}" "Stream ${stream_blocks} code blocks of 40 lines every ${stream_step_ms} ms." || exit 1
    sleep "${stream_warmup_s}"
    [[ "${repeat}" == "1" ]] && adb exec-out screencap -p >"${out}/stream-chat.png" 2>/dev/null
    measure_window stream "${repeat}" "${stream_s}" || break
    status="$(agent_status "${agent_id}")"
    log_event "stream ${repeat}: agent status at the end of the window: ${status}"
    [[ "${status}" == "running" ]] || problems+=("stream ${repeat}: the agent was '${status}' at the end of the window, so part of it did not stream; raise stream_blocks")
    stop_agent "${agent_id}"
    sleep 5
  done
fi

# taps: nothing running, so no ring or loader animates behind the sheet.
if [[ "${crashed}" == "false" ]]; then
  "${cli[@]}" stop --all --json "${host[@]}" >>"${events}" 2>&1 || true
  sleep 3
  if calibrate_taps; then
    for repeat in $(seq 1 "${repeats}"); do
      [[ "$(app_pid)" == "${start_pid}" ]] || {
        crashed=true
        break
      }
      for index in $(seq 1 "${control_tries}"); do
        try_control "${repeat}" "${index}" hold
      done
      max_tries=$((hold_tries > tap_tries ? hold_tries : tap_tries))
      for index in $(seq 0 $((max_tries - 1))); do
        delay="${delays_ms[$((index % ${#delays_ms[@]}))]}"
        [[ "${index}" -lt "${hold_tries}" ]] && try_sheet_row "${repeat}" "${index}" hold "${delay}"
        [[ "${index}" -lt "${tap_tries}" ]] && try_sheet_row "${repeat}" "${index}" tap "${delay}"
      done
      log_event "taps repeat ${repeat}: $(awk -F, -v r="${repeat}" '$1 == r { n[$2 "/" $3 "/" $6]++ } END { for (k in n) printf "%s=%d ", k, n[k] }' "${taps_csv}")"
    done
  else
    problems+=("the tap test could not find the Switch host sheet; see ui-perf/taps/")
  fi
fi

[[ "$(app_pid)" == "${start_pid}" ]] || crashed=true
log_event "end pid=$(app_pid)"
collect_end_state

node -e '
  const [file, label, apk, sync, uprobes, repeats] = process.argv.slice(1);
  require("fs").writeFileSync(file, JSON.stringify({ label, apk, syncUiProps: sync, uprobes, repeats }));
' "${out}/meta.json" "${UI_PERF_LABEL:-build run ${BUILD_RUN_ID:-?}}" "${APK_PATH##*/}" "${sync_ui_props:-?}" "${uprobes}" "${repeats}"
"${tools[@]}" summary "${windows_csv}" "${taps_csv}" "${out}/meta.json" >"${out}/summary.md"
cat "${out}/summary.md" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
cat "${out}/summary.md"
rm -f "${out}/.root.sh"

for problem in "${problems[@]}"; do
  echo "::warning::${problem}"
done
if [[ "${crashed}" == "true" ]]; then
  echo "::error::${APP_ID} died during the UI perf scenario. See ui-perf/exit-info.txt and native-crashes.txt."
  exit 1
fi
echo "UI perf scenario finished; the app stayed up."
