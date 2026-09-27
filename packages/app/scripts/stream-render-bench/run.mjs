// Bundles bench.ts and runs it under Node and, when PASEO_BENCH_HERMES points at a
// Hermes CLI, under Hermes. See bench.ts for what is measured.
//
//   node packages/app/scripts/stream-render-bench/run.mjs
//   PASEO_BENCH_HERMES=~/hermes/bin/hermes node packages/app/scripts/stream-render-bench/run.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformFileAsync } from "@babel/core";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(appRoot, "../..");

// Real repository source, so the highlighter sees realistic TypeScript.
const codeSample = [
  "src/agent-stream/text-reveal.ts",
  "src/agent-stream/presentation.ts",
  "src/utils/highlight-cache.ts",
]
  .map((file) => readFileSync(path.join(appRoot, file), "utf8"))
  .join("\n")
  .replaceAll("```", "'''");

// A tight list stays one Markdown block however long it grows, which is the live-block
// shape of an agent's summary or plan.
const proseSample = Array.from({ length: 80 }, (_, index) => {
  const n = index + 1;
  return `- **Step ${n}:** updated \`packages/app/src/module-${n}.ts\` so the [reveal](https://paseo.sh/docs/${n}) keeps _pacing_ while item ${n} streams, then checked the result.`;
}).join("\n");

const outDir = mkdtempSync(path.join(tmpdir(), "stream-render-bench-"));
const bundlePath = path.join(outDir, "bench.js");

await build({
  entryPoints: [path.join(here, "bench.ts")],
  bundle: true,
  outfile: bundlePath,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "es2019",
  alias: { "@": path.join(appRoot, "src") },
  conditions: ["source"],
  loader: { ".js": "jsx" },
  define: {
    BENCH_CODE_SAMPLE: JSON.stringify(codeSample),
    BENCH_PROSE_SAMPLE: JSON.stringify(proseSample),
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "warning",
  absWorkingDir: repoRoot,
});

function run(label, command, args) {
  const output = execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const report = JSON.parse(output.trim().split("\n").pop());
  console.log(`\n${label} (timer: ${report.timer})`);
  console.table(report.results);
  return report;
}

const reports = { node: run("Node", process.execPath, [bundlePath]) };
const hermes = process.env.PASEO_BENCH_HERMES;
if (hermes) {
  // Metro lowers syntax Hermes lacks, such as classes, with the React Native preset.
  // Run the same lowering so Hermes executes the code shape the app ships.
  const { code } = await transformFileAsync(bundlePath, {
    babelrc: false,
    configFile: false,
    sourceType: "script",
    compact: true,
    presets: [
      [
        "@react-native/babel-preset",
        { enableBabelRuntime: false, unstable_transformProfile: "hermes-stable" },
      ],
    ],
  });
  const hermesBundlePath = path.join(outDir, "bench.hermes.js");
  writeFileSync(hermesBundlePath, code);
  reports.hermes = run("Hermes", hermes, ["-O", hermesBundlePath]);
}
if (process.env.PASEO_BENCH_JSON) {
  console.log(JSON.stringify(reports));
}
