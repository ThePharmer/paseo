# Agent stream performance

How assistant text gets from a provider to the screen, and why it is paced on the way. Read this before changing `packages/server/src/server/agent/agent-stream-coalescer.ts`, the reducer queue in `packages/app/src/timeline/session-stream-reducers.ts`, the reveal in `packages/app/src/hooks/use-revealed-text.ts`, code highlighting in `packages/app/src/components/highlighted-code-block.tsx`, or the Android GC safety net in `packages/app/src/performance/gc-safety-net/`.

For terminal output, which is a separate pipeline with separate budgets, see [terminal-performance.md](terminal-performance.md).

## The pipeline

```
provider deltas (every provider streams incrementally)
  → AgentStreamCoalescer (daemon, leading + trailing, ≤1 message per 60ms per agent)
  → recordTimeline: one canonical row per flushed item
  → agent_stream ws message
  → reducer queue (app, one commit per frame) → session store
  → source-item plugin transforms → native Markdown blocks / tool grouping
  → paced reveal (app, per displayed item; web only for now) → paint
```

Every provider delivers incremental text, so there is no provider that needs special handling: Claude via `includePartialMessages`, Codex via `agent_message_delta`, ACP agents via `agent_message_chunk`, Pi and OMP via `text_delta`.

## Why the reveal is paced

Arrival is lumpy and there is no fixing that at the source. A 60ms coalescing window carries however many characters the model produced in those 60ms, which swings by an order of magnitude within a single turn. Painting each delta as it lands makes the size of those lumps visible, and that is what reads as jagged.

So arrival sets a _target_ and the reveal rate is derived from the backlog instead. A burst makes the text catch up faster; it does not make the text jump. Shrinking the coalescing window does not fix this — it makes the lumps smaller and more frequent, at the cost of message rate on a daemon loop that already contends with terminal frames and per-message relay encryption.

## Render cost on Hermes

iOS and Android run Hermes, which has no JIT. Each reveal step re-renders the growing block, and the JS cost of that render grows with the block. Per render of the live block, pure JS only (no React or native layout), from `packages/app/scripts/stream-render-bench` on one core of a 2013 Xeon E5-2680 v2 (2026-09). A recent flagship phone core is faster than that; a mid-range one is comparable:

| live block                           | Node (V8) p50 | Hermes p50 | Hermes p95 |
| ------------------------------------ | ------------- | ---------- | ---------- |
| tight list, 4,000 chars              | 1.6ms         | 15ms       | 21ms       |
| code fence, 10,000 chars, full parse | 5.5ms         | 77ms       | 109ms      |
| code fence, 10,000 chars, background | 0.6ms         | 6ms        | 8ms        |

Lezer's full parse is almost all of the code fence cost: about 10ms per 1,000 characters on Hermes. That is why highlighting a growing or long code block never happens during render (see the invariants below). The background path then spends about 10ms per frame catching up, in slices; its longest measured slice is 8ms against a 4ms target, since single parser and tokenizer steps can overrun it. Node's numbers understate Hermes cost by roughly ten times, so measure hot paths under Hermes.

## Native memory Hermes cannot see

Every Fabric commit replaces ShadowNode revisions, and the old revisions stay alive while a small JS wrapper still points at them. Those wrappers die only when Hermes collects, and Hermes does not count the native memory behind them. During streaming, or a large re-layout such as opening the keyboard on a long chat, the Android native heap grows by hundreds of MB while the JS heap looks idle, until Scudo aborts the app (seen at 2.5 GB RSS). A forced JS collection frees about 256 MB at once. React Native forces one only on memory trim levels that Android 14+ never delivers to apps.

`packages/app/src/performance/gc-safety-net/` makes Hermes see that memory. Once a second it reads `Debug.getNativeHeapAllocatedSize()` through the local `paseo-gc-pressure` Expo module and compares it with a baseline. Thresholds are named constants in `monitor.ts`.

- **Balloon.** The net keeps one armed balloon: an empty object carrying 1 byte of external memory pressure. Once `js_numGCs` advances, the balloon has survived a collection and lives in the old generation, so it is ripe. When native growth passes 96 MB, the net sets the ripe balloon's pressure to the growth (at least twice the JS heap, at most 1 GB), drops its only strong reference, and arms a new balloon. The pressure starts a concurrent old-generation collection, which frees the balloon along with the stale wrappers. When the balloon's `WeakRef` clears, the net rebaselines 2 s later, once finalizers have released the native memory.
- **Balloons are disposable.** Reading the Hermes source suggests that pressure still held when a collection starts raises the next collection's target, so a long-lived balloon would push each threshold higher than the last. Each balloon carries its pressure once and dies in the collection it started. For the same reason the net does not trigger again until the previous balloon is collected, and waits at least 5 s between triggers.
- **Fallback.** If the balloon is still uncollected 10 s after a trigger and growth is over 400 MB, the net calls `global.gc()`, a full blocking collection on the JS thread. It waits until 500 ms have passed with no touch, chat scroll, or keyboard animation (`interaction.ts` lists the hooks), and runs at most once a minute.
- **Degraded modes.** Without `WeakRef` or `HermesInternal.getInstrumentedStats` the balloon is off and only the fallback runs, on growth that stays over 400 MB for 10 s. Without `global.gc` as well, the net is off. An APK built before the native module existed runs nothing. iOS and web import the no-op `index.ts`.
- **Kill switch.** Set `GC_SAFETY_NET_ENABLED` in `monitor.ts` to `false`.

To read it on a phone, open Settings, run **App diagnostic**, and find the **GC safety net** section: the mode, why it is degraded, the current native heap and baseline, and the last 50 events. `t+` is seconds since the JS runtime started. A working cycle is `trigger`, then `collected` a few seconds later with a lower native heap, then `rebaseline`, with `external` back near 0. A `fallback-gc` row means the balloon did not work in time; its `pause` is how long the JS thread stalled. Each trigger and fallback also logs one `[GcSafetyNet]` line to logcat under `ReactNativeJS`.

The target on a device, not yet measured: native heap flat across a long stream, no spike above about 600 MB, `gcTime` under 1% of wall time, and a Perfetto frame timeline with no jank around triggers.

## Invariants

- **The coalescer is leading + trailing.** The first delta after an idle window flushes synchronously; only the rest of the burst waits for the trailing timer. Reverting to trailing-only adds a full window to the first character of every turn. Same shape and the same reason as `TerminalOutputCoalescer`.
- **The leading flush adds a canonical row, and that is fine.** A burst's first chunk lands as its own timeline row. `mergeAssistantChunks` / `mergeReasoningChunks` in `timeline-projection.ts` join contiguous same-turn rows, and clients read the projected timeline, so history is unaffected. Tests that assert on raw rows have to account for the extra row; tests that assert on what a client sees do not.
- **The store holds the full text; only the rendered slice is paced.** Copy, selection, the chat outline, and scroll geometry all read the same string the user can see. Pacing the store instead would leave the bottom anchor chasing a content height that is ahead of the reveal.
- **Markdown blocks belong to presentation, and every assistant message is a block group.**
  `agent-stream/presentation.ts` splits a message into one display row per Markdown block, the same
  way whether it arrived streaming or as fetched history. Splitting in the reducer instead would
  discard paragraph separators and expose fragments to plugin callbacks, which need the whole source
  text. Live-head work stays cheap by parsing only the growing last block during append, retaining
  completed blocks by object identity, and caching the split per source item so a tail change does
  not re-split history. History was once left whole to keep cross-block Markdown context; that gave
  one message two shapes depending on how it arrived, and message-addressed features only worked on
  one of them.
- **A row id is never a message id.** Block rows are `${messageId}:block:${n}` with
  `blockGroupId = messageId`, including single-block messages, so nothing can come to rely on the two
  being equal. `getStreamItemMessageId` in `presentation.ts` is the only way to go from a row to its
  message, and web rows carry it as `data-message-id` alongside `data-history-row-id`. Anything
  addressing a message — chat find, scroll-to-message, history reveal, the find expansion that lifts
  the render cap — uses the message id and must expect several rows to answer to it. Row ids stay for
  React keys, virtualizer measurement, scroll anchors, and per-row caches like assistant image
  occurrence keys.
- **First sight of a text is revealed whole.** Only growth is paced. This is what makes history hydration, timeline replay, a virtualized row remounting on scroll, and an already-finished message all render complete on first paint without a special case for each.
- **Leaving `phase: "streaming"` snaps the reveal.** A completed turn must never be left holding characters. `layoutStream` sets the phase, so anything outside the live head with an active turn is already complete.
- **The reveal can run on every engine, but native pacing is off for now.** Hermes has no `Intl.Segmenter`, and the reveal was once switched off wherever it was missing. `utils/grapheme-boundary.ts` falls back to the UAX #29 pair rules, widened toward joining where Hermes cannot test a property cheaply: a missed boundary holds text back for a frame, a false one paints half a grapheme. Its test checks the fallback against `Intl.Segmenter` on random mixed-script text. Do not gate pacing on a platform API again without a fallback. Separately, `useRevealedText` paces on web only because native-heap growth on Android is per commit (see [Native memory Hermes cannot see](#native-memory-hermes-cannot-see)): pacing raises a streaming block's commit rate on native from one per arrival (about 16/s) to up to 60/s. iOS and Android paint each arrival whole; remove the `isWeb` gate once device measurements show the GC safety net holds the native heap flat under paced streaming.
- **Reveal commits are spaced by render cost.** `useRevealedText` times each reveal-driven commit from its render to its layout effect and spaces frames so those renders take at most `TEXT_REVEAL_RENDER_BUDGET` of the JS thread. The sample includes scheduling and other work in the same commit, so treat it as a congestion signal, not an attribution. It keeps 60Hz where rendering is cheap; it does not bound a single long render, which only lowering the render cost does.
- **Growing or long code is highlighted off the render path.** `HighlightedCodeBlock` highlights a streaming fence, and any settled block over `SYNC_HIGHLIGHT_MAX_CHARS`, with `BackgroundHighlighter` in 4ms slices between frames. It paints unhighlighted text past the last finished highlight. While code grows it reuses the previous Lezer parse and tokenizes only the last few lines again; once the block settles it tokenizes every line, so the final colors match a one-shot highlight, and stores the result in the shared tokenization cache so a remount does not parse again. Do not cache streaming prefixes there: each one would evict a useful entry. Tokenizing steps may stop partway through a line, so a long minified line cannot become one long step. On web, a settled block does not take new colors while a selection is inside it, because replacing the text nodes collapses the selection.
- **The reducer queue commits on a frame, with a timer as the ceiling.** A frame callback never fires in a hidden tab, so a timer races it and wins when nothing is painting — the store has to keep advancing either way.
- **A history row re-renders only when its item or layout item identity changes.** The inverted
  FlatList hands every mounted cell a new `index` and `ref` whenever a row is prepended, so without a
  memo boundary each coalesced tick re-rendered every mounted row (about 50 on a phone, 100–250 ms of
  JS per tick). `layoutStream` keeps a layout item's identity when nothing about it changed,
  `useRevisedHistoryRows` hands a fresh item identity to rows whose tool-call group, expanded state,
  or breakpoint changed, and `HistoryStreamRow` memoizes on both. Every viewport runs its history
  through that hook; the web viewport once skipped it and history hosts of a live tool group went
  stale. A new field on `StreamLayoutItem` must be added to `areLayoutItemsEquivalent`, or sharing
  silently stops.

## Measuring

- **Smoothness (user-perceived):** `packages/app/e2e/browser/agent-stream-smoothness.spec.ts`, gated behind `PASEO_AGENT_STREAM_PERF_E2E=1`. Drives the mock provider's `bursty-stream` model and reports coefficient of variation of characters painted per frame (smoothness) plus p95 gap between visible updates (stalls). Both numbers are needed: a stalled stream is perfectly smooth.
- **Reproducing bursty arrival:** the `bursty-stream` model in `mock-load-test-agent.ts` emits uneven runs of tokens separated by idle gaps. Burst sizes come from a seeded generator, so a run repeats exactly.
- **Rate policy in isolation:** `computeRevealStep` in `packages/app/src/agent-stream/text-reveal.ts` is pure; `text-reveal.test.ts` covers convergence and burst flattening without a renderer.
- **Per-render JS cost on Hermes:** `node packages/app/scripts/stream-render-bench/run.mjs` replays a streaming prose list and code fence through the same split, parse, and highlight functions the app calls, under Node. Set `PASEO_BENCH_HERMES` to a Hermes CLI to run the same bundle under Hermes, lowered with the React Native Babel preset the way Metro lowers it. Build that CLI from the tag in `node_modules/react-native/sdks/.hermesversion` (`cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DHERMES_ENABLE_TEST_SUITE=OFF`, target `hermes`; Linux needs `libicu-dev`). The CLI has no `performance.now`, so its numbers have 1ms resolution. Do not measure while a native build is running on the same machine: preemption shows up as 4–6ms steps.

Healthy numbers (2026-08, Expo web against a local dev daemon, real Claude Haiku agent, ~8.5s samples during active streaming). Setting `TEXT_REVEAL_HORIZON_MS` to 0 makes the reveal paint on arrival, which is how the baseline column was taken:

|                                  | paint on arrival | paced |
| -------------------------------- | ---------------- | ----- |
| frames that advanced the text    | 6%               | 87%   |
| chars-per-frame CV               | 4.11             | 1.86  |
| gap between visible updates, p50 | 317ms            | 17ms  |
| gap between visible updates, p95 | 383ms            | 17ms  |

Total characters painted is roughly the same either way — the reveal changes when they land, not how many arrive.

Measure the **total** length across every `assistant-message` element, not the last one. A turn emits many assistant messages, so the tail element keeps changing identity and its length is not monotonic; sampling only the tail reads those handovers as resets and reports almost no growth. `sampleStreamFrames` does this correctly.
