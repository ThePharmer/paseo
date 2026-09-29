#!/usr/bin/env node
// Parsers and summaries for the ui-perf scenario (ui-perf.sh). Every command
// reads files the scenario pulled from the emulator and prints plain text, so
// the shell side stays free of parsing.
//
//   apk-flags <apk>                          Reanimated static feature flags compiled into the APK
//   uprobe-offsets <apk> <lib> <symbol>...   "<symbol> <apk file offset> <lib file offset>" per symbol
//   task-cpu <before> <after> <pid> <sec>    JSON: CPU ms/s of the main, JS and render threads
//   atrace <atrace.txt> <pid> <sec> <hist>   JSON: frame and mount section counts per second
//   uprobes <trace.txt> <tasks> <pid> <sec>  JSON: probe hits per second, split by thread
//   bounds <window.xml> <resource-id>        "<cx> <cy>" of the first on-screen node with that id
//   has-id <window.xml> <resource-id>...     exits 0 when any id is on screen
//   summary <windows.csv> <taps.csv> <meta>  markdown summary, median [min-max] over repeats
import fs from "node:fs";
import zlib from "node:zlib";

const [command, ...args] = process.argv.slice(2);

function readZipEntry(apkPath, entryName) {
  const buf = fs.readFileSync(apkPath);
  // End of central directory: signature 0x06054b50, searched from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${apkPath}: no zip end of central directory`);
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeader = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === entryName) {
      const localNameLength = buf.readUInt16LE(localHeader + 26);
      const localExtraLength = buf.readUInt16LE(localHeader + 28);
      const dataOffset = localHeader + 30 + localNameLength + localExtraLength;
      const raw = buf.subarray(dataOffset, dataOffset + compressedSize);
      const data = method === 0 ? raw : zlib.inflateRawSync(raw);
      return { data, dataOffset, stored: method === 0 };
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${apkPath}: no entry ${entryName}`);
}

// Dynamic symbols and PT_LOAD segments of a 64-bit little-endian ELF.
function readElf(data) {
  if (data.readUInt32BE(0) !== 0x7f454c46 || data[4] !== 2 || data[5] !== 1) {
    throw new Error("not a 64-bit little-endian ELF");
  }
  const phoff = Number(data.readBigUInt64LE(32));
  const shoff = Number(data.readBigUInt64LE(40));
  const phentsize = data.readUInt16LE(54);
  const phnum = data.readUInt16LE(56);
  const shentsize = data.readUInt16LE(58);
  const shnum = data.readUInt16LE(60);
  const loads = [];
  for (let i = 0; i < phnum; i += 1) {
    const p = phoff + i * phentsize;
    if (data.readUInt32LE(p) === 1) {
      loads.push({
        offset: Number(data.readBigUInt64LE(p + 8)),
        vaddr: Number(data.readBigUInt64LE(p + 16)),
        filesz: Number(data.readBigUInt64LE(p + 32)),
      });
    }
  }
  const sections = [];
  for (let i = 0; i < shnum; i += 1) {
    const s = shoff + i * shentsize;
    sections.push({
      type: data.readUInt32LE(s + 4),
      offset: Number(data.readBigUInt64LE(s + 24)),
      size: Number(data.readBigUInt64LE(s + 32)),
      link: data.readUInt32LE(s + 40),
      entsize: Number(data.readBigUInt64LE(s + 56)),
    });
  }
  const symbols = new Map();
  const dynsym = sections.find((section) => section.type === 11); // SHT_DYNSYM
  if (dynsym) {
    const strtab = sections[dynsym.link];
    for (let off = dynsym.offset; off < dynsym.offset + dynsym.size; off += dynsym.entsize || 24) {
      const nameOffset = data.readUInt32LE(off);
      const shndx = data.readUInt16LE(off + 6);
      const value = Number(data.readBigUInt64LE(off + 8));
      if (shndx === 0 || value === 0) continue;
      const start = strtab.offset + nameOffset;
      const end = data.indexOf(0, start);
      symbols.set(data.toString("latin1", start, end), value);
    }
  }
  return { loads, symbols };
}

function fileOffsetForVaddr(loads, vaddr) {
  const load = loads.find((l) => vaddr >= l.vaddr && vaddr < l.vaddr + l.filesz);
  if (!load) throw new Error(`vaddr 0x${vaddr.toString(16)} is in no PT_LOAD segment`);
  return vaddr - load.vaddr + load.offset;
}

// "tid (comm) S ppid ..." lines from /proc/<pid>/task/*/stat -> Map tid -> {comm, ticks}.
function readTaskStats(file) {
  const tasks = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const open = line.indexOf("(");
    const close = line.lastIndexOf(")");
    if (open < 0 || close < open) continue;
    const tid = Number(line.slice(0, open).trim());
    const rest = line.slice(close + 2).trim().split(/\s+/);
    // rest[0] is field 3 (state); utime and stime are fields 14 and 15.
    const ticks = Number(rest[11]) + Number(rest[12]);
    if (Number.isFinite(tid) && Number.isFinite(ticks)) {
      tasks.set(tid, { comm: line.slice(open + 1, close), ticks });
    }
  }
  return tasks;
}

const isJsThread = (comm) => /^mqt_(v_)?js$/.test(comm);

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseNodes(xml) {
  const nodes = [];
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const tag = match[0];
    const attr = (name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
    const b = attr("bounds").match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    const [left, top, right, bottom] = b.slice(1).map(Number);
    nodes.push({ id: attr("resource-id"), text: attr("text"), left, top, right, bottom });
  }
  return nodes;
}

function onScreenNode(xml, id) {
  const nodes = parseNodes(xml);
  // The root node spans the screen; nodes outside it or with no area are off screen.
  const screen = nodes[0] ?? { left: 0, top: 0, right: 1e9, bottom: 1e9 };
  return nodes.find(
    (node) =>
      node.id === id &&
      node.right > node.left &&
      node.bottom > node.top &&
      node.top >= screen.top &&
      node.bottom <= screen.bottom &&
      node.left >= screen.left &&
      node.right <= screen.right,
  );
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const [header, ...lines] = fs.readFileSync(file, "utf8").trim().split("\n");
  if (!header) return [];
  const keys = header.split(",");
  return lines
    .filter(Boolean)
    .map((line) => Object.fromEntries(line.split(",").map((value, i) => [keys[i], value])));
}

function fmtStat(values, digits = 1) {
  const nums = values.map(Number).filter((v) => Number.isFinite(v));
  if (nums.length === 0) return "n/a";
  const m = round(median(nums), digits);
  if (nums.length === 1) return `${m}`;
  return `${m} [${round(Math.min(...nums), digits)}-${round(Math.max(...nums), digits)}]`;
}

const commands = {
  "apk-flags"([apk]) {
    const { data } = readZipEntry(apk, "lib/x86_64/libreanimated.so");
    const text = data.toString("latin1");
    const flags = {};
    for (const match of text.matchAll(/\[([A-Z0-9_]+):(true|false)\]/g)) {
      flags[match[1]] = match[2] === "true";
    }
    console.log(JSON.stringify(flags));
  },

  "uprobe-offsets"([apk, lib, ...symbols]) {
    const { data, dataOffset, stored } = readZipEntry(apk, lib);
    const { loads, symbols: table } = readElf(data);
    for (const symbol of symbols) {
      const vaddr = table.get(symbol);
      if (vaddr === undefined) {
        console.error(`${lib}: no exported symbol ${symbol}`);
        continue;
      }
      const libOffset = fileOffsetForVaddr(loads, vaddr);
      const apkOffset = stored ? dataOffset + libOffset : -1;
      console.log(`${symbol} 0x${apkOffset.toString(16)} 0x${libOffset.toString(16)}`);
    }
  },

  "task-cpu"([beforeFile, afterFile, pidText, secondsText]) {
    const pid = Number(pidText);
    const seconds = Number(secondsText);
    const before = readTaskStats(beforeFile);
    const after = readTaskStats(afterFile);
    const perThread = [];
    for (const [tid, task] of after) {
      // A thread born during the window counts from zero.
      const delta = task.ticks - (before.get(tid)?.ticks ?? 0);
      perThread.push({ tid, comm: task.comm, ms: delta * 10 });
    }
    const sum = (filter) => perThread.filter(filter).reduce((total, t) => total + t.ms, 0);
    const perSecond = (ms) => round(ms / seconds);
    const top = [...perThread].sort((a, b) => b.ms - a.ms).slice(0, 8);
    console.log(
      JSON.stringify({
        main_cpu_ms_s: perSecond(sum((t) => t.tid === pid)),
        js_cpu_ms_s: perSecond(sum((t) => isJsThread(t.comm))),
        render_cpu_ms_s: perSecond(sum((t) => t.comm === "RenderThread")),
        process_cpu_ms_s: perSecond(sum(() => true)),
        js_thread_names: [...new Set(perThread.filter((t) => isJsThread(t.comm)).map((t) => t.comm))].join("|"),
        top_threads: top.map((t) => `${t.comm}:${perSecond(t.ms)}`).join(" "),
      }),
    );
  },

  atrace([file, pidText, secondsText, histogramFile]) {
    const pid = Number(pidText);
    const seconds = Number(secondsText);
    const line = /^\s*(.+?)-(\d+)\s+(?:\(\s*[-\d]+\)\s+)?\[\d+\]\s+\S+\s+[\d.]+: tracing_mark_write: B\|(\d+)\|(.*)$/;
    const counts = new Map();
    let total = 0;
    for (const text of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.exec(text);
      if (!m || Number(m[3]) !== pid) continue;
      total += 1;
      const tid = Number(m[2]);
      const thread = tid === pid ? "main" : m[1].trim();
      const name = m[4].split("|")[0].replace(/\d+/g, "#").trim();
      const key = `${thread}\t${name}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const count = (predicate) =>
      [...counts].filter(([key]) => predicate(...key.split("\t"))).reduce((t, [, n]) => t + n, 0);
    const rows = [...counts].sort((a, b) => b[1] - a[1]);
    fs.writeFileSync(
      histogramFile,
      rows.map(([key, n]) => `${n}\t${round(n / seconds)}/s\t${key}`).join("\n") + "\n",
    );
    const perSecond = (n) => round(n / seconds);
    console.log(
      JSON.stringify({
        trace_sections: total,
        doframe_s: perSecond(count((t, n) => t === "main" && n.startsWith("Choreographer#doFrame"))),
        mount_batches_s: perSecond(count((_, n) => n === "IntBufferBatchMountItem::mountViews")),
        update_props_groups_s: perSecond(
          count((_, n) => n === "IntBufferBatchMountItem::mountInstructions::UPDATE_PROPS"),
        ),
        mount_dispatch_s: perSecond(
          count((_, n) => n === "MountItemDispatcher::mountViews mountItems to execute"),
        ),
      }),
    );
  },

  uprobes([file, tasksFile, pidText, secondsText]) {
    const pid = Number(pidText);
    const seconds = Number(secondsText);
    const tasks = readTaskStats(tasksFile);
    // Every probe and thread class is present, so a probe that never fired reads 0.
    const counts = {};
    for (const probe of ["commit", "mount", "syncupd"]) {
      for (const thread of ["main", "js", "other"]) counts[`${probe}_${thread}_s`] = 0;
    }
    const line = /^\s*(.+?)-(\d+)\s+.*?\s[\d.]+: (\w+): \(/;
    for (const text of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.exec(text);
      if (!m) continue;
      const tid = Number(m[2]);
      if (!tasks.has(tid)) continue;
      const comm = tasks.get(tid).comm;
      let thread = "other";
      if (tid === pid) thread = "main";
      else if (isJsThread(comm)) thread = "js";
      const key = `${m[3]}_${thread}_s`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    for (const key of Object.keys(counts)) counts[key] = round(counts[key] / seconds);
    console.log(JSON.stringify(counts));
  },

  bounds([file, id]) {
    const node = onScreenNode(fs.readFileSync(file, "utf8"), id);
    if (!node) process.exit(1);
    console.log(`${Math.round((node.left + node.right) / 2)} ${Math.round((node.top + node.bottom) / 2)}`);
  },

  "has-id"([file, ...ids]) {
    const xml = fs.readFileSync(file, "utf8");
    process.exit(ids.some((id) => onScreenNode(xml, id)) ? 0 : 1);
  },

  summary([windowsFile, tapsFile, metaFile]) {
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
    const windows = readCsv(windowsFile);
    const taps = readCsv(tapsFile);
    const out = [];
    out.push(`### UI thread work (${meta.label ?? "ui-perf"})\n`);
    out.push(
      `APK: \`${meta.apk ?? "?"}\`. Reanimated ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS: **${meta.syncUiProps ?? "?"}**. ` +
        `Commit probes: **${meta.uprobes ?? "?"}**. Median [min-max] over ${meta.repeats ?? "?"} repeats.\n`,
    );
    const metrics = [
      ["main_cpu_ms_s", "main thread CPU ms/s"],
      ["js_cpu_ms_s", "JS thread CPU ms/s"],
      ["commit_main_s", "Fabric commits/s on main (Reanimated, native state)"],
      ["commit_js_s", "Fabric commits/s on JS (React)"],
      ["mount_batches_s", "mount batches/s (IntBufferBatchMountItem::mountViews)"],
      ["update_props_groups_s", "UPDATE_PROPS groups/s"],
      ["doframe_s", "Choreographer#doFrame/s"],
      ["frames_s", "frames rendered/s (gfxinfo)"],
      ["render_cpu_ms_s", "RenderThread CPU ms/s (software GPU, context only)"],
      ["process_cpu_ms_s", "whole process CPU ms/s"],
    ];
    const phases = [...new Set(windows.map((w) => w.phase))];
    if (phases.length > 0) {
      out.push(`| metric | ${phases.join(" | ")} |`);
      out.push(`|---|${phases.map(() => "---").join("|")}|`);
      for (const [key, label] of metrics) {
        const cells = phases.map((phase) =>
          fmtStat(windows.filter((w) => w.phase === phase).map((w) => w[key])),
        );
        if (cells.every((cell) => cell === "n/a")) continue;
        out.push(`| ${label} | ${cells.join(" | ")} |`);
      }
      out.push("");
    }
    if (taps.length > 0) {
      out.push("#### Taps in the Settings > Switch host sheet\n");
      out.push(
        "Per repeat: tries whose row action ran / tries whose press was dropped (sheet stayed open) / tries that missed (sheet closed without the action). " +
          "`tap` is `input tap` (down, up); `hold` is a zero-distance `input swipe` (down, moves, up), which is what makes Pressable re-check its press rectangle.\n",
      );
      out.push("| target | style | acted | dropped | missed | tries/repeat |");
      out.push("|---|---|---|---|---|---|");
      const groups = [...new Set(taps.map((t) => `${t.target}\t${t.style}`))];
      for (const group of groups) {
        const [target, style] = group.split("\t");
        const rows = taps.filter((t) => t.target === target && t.style === style);
        const repeats = [...new Set(rows.map((t) => t.repeat))];
        const per = (outcome) =>
          repeats.map((r) => rows.filter((t) => t.repeat === r && t.outcome === outcome).length);
        const tries = repeats.map((r) => rows.filter((t) => t.repeat === r).length);
        out.push(
          `| ${target} | ${style} | ${fmtStat(per("acted"), 0)} | ${fmtStat(per("dropped"), 0)} | ${fmtStat(per("missed"), 0)} | ${fmtStat(tries, 0)} |`,
        );
      }
      const rowTaps = taps.filter((t) => t.target === "sheet-row");
      const delays = [...new Set(rowTaps.map((t) => Number(t.delay_ms)))].sort((a, b) => a - b);
      const styles = [...new Set(rowTaps.map((t) => t.style))];
      if (delays.length > 0) {
        out.push(
          "\nSheet-row presses by delay after the trigger tap, all repeats. The measured gap runs from the end of the trigger's `input` command to the row's down event, so it includes the row command's start-up.\n",
        );
        out.push(`| delay ms | ${styles.map((st) => `${st} gap ms | ${st} dropped / missed / tries`).join(" | ")} |`);
        out.push(`|---|${styles.map(() => "---|---").join("|")}|`);
        for (const delay of delays) {
          const cells = styles.map((st) => {
            const rows = rowTaps.filter((t) => Number(t.delay_ms) === delay && t.style === st);
            const count = (outcome) => rows.filter((t) => t.outcome === outcome).length;
            return `${round(median(rows.map((t) => Number(t.gap_ms))), 0)} | ${count("dropped")} / ${count("missed")} / ${rows.length}`;
          });
          out.push(`| ${delay} | ${cells.join(" | ")} |`);
        }
      }
      out.push("");
    }
    console.log(out.join("\n"));
  },
};

if (!commands[command]) {
  console.error(`Unknown command ${command}. Commands: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
try {
  commands[command](args);
} catch (error) {
  console.error(`${command}: ${error.message}`);
  process.exit(1);
}
