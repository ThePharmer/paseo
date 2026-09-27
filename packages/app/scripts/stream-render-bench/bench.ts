// Per-frame JavaScript cost of rendering a streaming assistant message, without React.
//
// Replays the pure work one AssistantMessage render does for the live block as the
// paced reveal grows it: block splitting, markdown-it parsing plus the AST pass that
// react-native-markdown-display runs, and syntax highlighting of a growing code fence.
// Bundled by run.mjs so the same code runs under Node and under a Hermes CLI built
// from the React Native release's Hermes tag. Hermes has no JIT, so its numbers are
// the ones that approximate a phone; Node's are a lower bound.

import { createBackgroundHighlighter, highlightCode } from "@getpaseo/highlight";
import markdownDisplayParser from "react-native-markdown-display/src/lib/parser";
import { composeCodeHighlight } from "@/hooks/use-background-highlight";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";

declare const BENCH_CODE_SAMPLE: string;
declare const BENCH_PROSE_SAMPLE: string;
declare function print(...args: unknown[]): void;

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

const emit: (line: string) => void =
  typeof print === "function" ? (line) => print(line) : (line) => console.log(line);

// Characters the reveal releases per 60Hz frame at a typical ~720 chars/s stream.
const CHARS_PER_FRAME = 12;

// The slice the app's background highlighter yields after (use-background-highlight.ts).
const HIGHLIGHT_SLICE_MS = 4;

const markdownParser = createAssistantMarkdownParser();
const streamingMarkdownParser = createAssistantMarkdownParser({ streaming: true });
const identityRenderer = (ast: unknown) => ast;

function fenceBody(block: string): string | null {
  const match = /^```[^\n]*\n([\s\S]*)$/.exec(block);
  if (!match) return null;
  return match[1]!.replace(/\n?```\s*$/, "");
}

interface FrameCost {
  /** Work done while rendering, which blocks the frame. */
  renderMs: number;
  /** Longest single background highlight slice after the render. */
  sliceMs: number;
  /** All background highlight work for the frame. */
  backgroundMs: number;
}

type HighlightMode = "sync" | "background";

const backgroundHighlighter = createBackgroundHighlighter("x.ts")!;

/** The work one render of the live block does, excluding React and native layout. */
function renderLiveBlock(text: string, mode: HighlightMode): FrameCost {
  const start = now();
  const blocks = splitMarkdownBlocks(text);
  const block = blocks[blocks.length - 1] ?? "";
  markdownDisplayParser(block, identityRenderer, streamingMarkdownParser);
  const code = fenceBody(block);
  if (code !== null && mode === "sync") highlightCode(code, "x.ts");
  if (code !== null && mode === "background") {
    composeCodeHighlight(code, backgroundHighlighter.latest);
  }
  const renderMs = now() - start;

  let sliceMs = 0;
  let backgroundMs = 0;
  if (code === null || mode !== "background") return { renderMs, sliceMs, backgroundMs };
  while (!backgroundHighlighter.isCaughtUp(code)) {
    const sliceStart = now();
    backgroundHighlighter.work(code, () => now() - sliceStart >= HIGHLIGHT_SLICE_MS);
    const elapsed = now() - sliceStart;
    sliceMs = Math.max(sliceMs, elapsed);
    backgroundMs += elapsed;
  }
  return { renderMs, sliceMs, backgroundMs };
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

interface BucketResult {
  scenario: string;
  size: string;
  frames: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  sliceMaxMs?: number;
  backgroundP50Ms?: number;
}

/**
 * Grow `source` by one frame's worth of characters at a time and time each render.
 * Growing defeats the tokenization cache the same way streaming does.
 */
function replayGrowth(
  scenario: string,
  prefix: string,
  source: string,
  buckets: number[],
  mode: HighlightMode = "sync",
) {
  const results: BucketResult[] = [];
  let lower = 0;
  for (const upper of buckets) {
    const costs: FrameCost[] = [];
    const end = Math.min(upper, source.length);
    for (let length = Math.max(lower, 1); length <= end; length += CHARS_PER_FRAME) {
      costs.push(renderLiveBlock(prefix + source.slice(0, length), mode));
    }
    lower = end;
    if (costs.length === 0) continue;
    const samples = costs.map((cost) => cost.renderMs).sort((a, b) => a - b);
    const background = costs.map((cost) => cost.backgroundMs).sort((a, b) => a - b);
    results.push({
      scenario,
      size: `${upper} chars`,
      frames: samples.length,
      p50Ms: round(percentile(samples, 0.5)),
      p95Ms: round(percentile(samples, 0.95)),
      maxMs: round(samples[samples.length - 1]!),
      ...(mode === "background"
        ? {
            sliceMaxMs: round(Math.max(...costs.map((cost) => cost.sliceMs))),
            backgroundP50Ms: round(percentile(background, 0.5)),
          }
        : {}),
    });
  }
  return results;
}

function timelineOfSize(targetBytes: number) {
  const items = [];
  const perItem = Math.floor(targetBytes / 50);
  const text = BENCH_PROSE_SAMPLE.repeat(Math.ceil(perItem / BENCH_PROSE_SAMPLE.length)).slice(
    0,
    perItem,
  );
  for (let index = 0; index < 50; index += 1) {
    items.push({
      kind: index % 3 === 0 ? "tool_call" : "assistant_message",
      id: `item-${index}`,
      timestamp: 1_760_000_000_000 + index,
      timelineCursor: { epoch: "e1", seq: index },
      text,
      payload: { name: "Read", status: "completed", output: index % 3 === 0 ? text : null },
    });
  }
  return { agentId: "agent-1", range: null, items };
}

function benchCacheFlush() {
  const results: BucketResult[] = [];
  for (const bytes of [100_000, 500_000, 2_000_000]) {
    const timeline = timelineOfSize(bytes);
    const samples: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const start = now();
      JSON.stringify(timeline);
      samples.push(now() - start);
    }
    samples.sort((a, b) => a - b);
    results.push({
      scenario: "cache-flush-stringify",
      size: `${bytes / 1000} KB`,
      frames: samples.length,
      p50Ms: round(percentile(samples, 0.5)),
      p95Ms: round(percentile(samples, 0.95)),
      maxMs: round(samples[samples.length - 1]!),
    });
  }
  return results;
}

function benchCompletedParse() {
  const samples: number[] = [];
  const text = BENCH_PROSE_SAMPLE.slice(0, 4000);
  for (let run = 0; run < 50; run += 1) {
    const start = now();
    markdownDisplayParser(text, identityRenderer, markdownParser);
    samples.push(now() - start);
  }
  samples.sort((a, b) => a - b);
  return [
    {
      scenario: "history-block-parse",
      size: "4000 chars",
      frames: samples.length,
      p50Ms: round(percentile(samples, 0.5)),
      p95Ms: round(percentile(samples, 0.95)),
      maxMs: round(samples[samples.length - 1]!),
    },
  ];
}

// Warm up so both engines are measured past lazy compilation of the modules.
replayGrowth("warmup", "", BENCH_PROSE_SAMPLE, [600]);
replayGrowth("warmup", "```ts\n", BENCH_CODE_SAMPLE, [600]);

const results = [
  ...replayGrowth("prose-live-block", "", BENCH_PROSE_SAMPLE, [500, 1000, 2000, 4000]),
  ...replayGrowth(
    "code-fence-sync-highlight",
    "```ts\n",
    BENCH_CODE_SAMPLE,
    [1000, 2500, 5000, 10000],
  ),
  ...replayGrowth(
    "code-fence-background-highlight",
    "```ts\n",
    BENCH_CODE_SAMPLE,
    [1000, 2500, 5000, 10000],
    "background",
  ),
  ...benchCompletedParse(),
  ...benchCacheFlush(),
];

emit(
  JSON.stringify({ timer: typeof performance !== "undefined" ? "performance" : "date", results }),
);
