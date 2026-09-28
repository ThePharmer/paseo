# Agent stream performance

How assistant text gets from a provider to the screen, and why it is paced on the way. Read this before changing `packages/server/src/server/agent/agent-stream-coalescer.ts`, the reducer queue in `packages/app/src/timeline/session-stream-reducers.ts`, or the reveal in `packages/app/src/hooks/use-revealed-text.ts`.

For terminal output, which is a separate pipeline with separate budgets, see [terminal-performance.md](terminal-performance.md).

## The pipeline

```
provider deltas (every provider streams incrementally)
  → AgentStreamCoalescer (daemon, leading + trailing, ≤1 message per 60ms per agent;
                          paragraph delivery holds assistant text until a block is finished)
  → recordTimeline: one canonical row per flushed item
  → agent_stream ws message
  → reducer queue (app, one commit per frame) → session store
  → source-item plugin transforms → native Markdown blocks / tool grouping
  → paced reveal (app, per displayed item) → paint
```

Every provider delivers incremental text, so there is no provider that needs special handling: Claude via `includePartialMessages`, Codex via `agent_message_delta`, ACP agents via `agent_message_chunk`, Pi and OMP via `text_delta`.

## Assistant text delivery

`daemon.assistantTextDelivery` (env `PASEO_ASSISTANT_TEXT_DELIVERY`) picks what the coalescer does with assistant text. It is read at startup and applies to every client; the wire format does not change, clients just receive fewer, larger `assistant_message` chunks. User-facing docs are in `public-docs/configuration.md`.

- **`token`** (default) flushes whatever arrived in each 60ms window.
- **`paragraph`** holds the unfinished tail of the current message and releases up to the last boundary: a blank line outside a fenced code block, or a closing fence. Only complete lines count, so a half-written fence marker never creates a boundary. Fences opened after list or blockquote markers (`- ```ts`, `> ~~~`) count. A closer strips only its opener's blockquote depth, never list markers, so `- ```` inside a code block stays code. The scanner does not track container nesting, so it errs toward reading an indented line as a fence, which only holds text longer. It is a single cursor pass per line, including the trailing-whitespace trim, and runs synchronously on the daemon's event loop: a regex over repeated container prefixes is exponential on lines like `> > > … x`, and an unanchored `/[ \t\r]+$/`is quadratic on a long space run. Keep regexes out of this scanner;`markdown-paragraph-boundary.test.ts` guards the cost.

It exists for React Native Fabric on Android. Every commit of a growing message leaves a stale shadow-node revision holding the whole message's attributed text, one fragment per syntax token, until Hermes collects it. A long chat streaming at one commit per arrival runs the app out of native memory; fewer, larger commits cut that. t3code's `responseStreamingMode` does the same server-side.

Paragraph delivery rules, all in `agent-stream-coalescer.ts`:

- Releases of one message are at least `PARAGRAPH_DELIVERY_MIN_INTERVAL_MS` (400ms) apart. Paragraphs finished inside the interval wait on a timer and land together. The first release of a new message is immediate. Time alone never releases a partial paragraph.
- Held text past `PARAGRAPH_DELIVERY_MAX_HELD_CHARS` (24 KB) is released at its last complete line, pacing or not. If that cut is inside a fence, the open fence carries over, so the rest of the block still waits for its closing fence.
- Anything else for the agent releases all held text first: a tool call, reasoning, another message, and every event the coalescer does not own (turn completed, failed, or canceled, permission requests, user messages). Interrupt, steer admission, out-of-band command replies, `appendTimelineItem`, agent close, and shutdown flush too. `usage_updated`, `thread_started`, and mode, model, or thinking-option changes have no timeline position, so a partial paragraph stays held across them; usage updates arrive many times per message.
- Reasoning shares the buffer but is never held: it stays on the 60ms window.

## Why the reveal is paced

Arrival is lumpy and there is no fixing that at the source. A 60ms coalescing window carries however many characters the model produced in those 60ms, which swings by an order of magnitude within a single turn. Painting each delta as it lands makes the size of those lumps visible, and that is what reads as jagged.

So arrival sets a _target_ and the reveal rate is derived from the backlog instead. A burst makes the text catch up faster; it does not make the text jump. Shrinking the coalescing window does not fix this — it makes the lumps smaller and more frequent, at the cost of message rate on a daemon loop that already contends with terminal frames and per-message relay encryption.

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

Healthy numbers (2026-08, Expo web against a local dev daemon, real Claude Haiku agent, ~8.5s samples during active streaming). Setting `TEXT_REVEAL_HORIZON_MS` to 0 makes the reveal paint on arrival, which is how the baseline column was taken:

|                                  | paint on arrival | paced |
| -------------------------------- | ---------------- | ----- |
| frames that advanced the text    | 6%               | 87%   |
| chars-per-frame CV               | 4.11             | 1.86  |
| gap between visible updates, p50 | 317ms            | 17ms  |
| gap between visible updates, p95 | 383ms            | 17ms  |

Total characters painted is roughly the same either way — the reveal changes when they land, not how many arrive.

Measure the **total** length across every `assistant-message` element, not the last one. A turn emits many assistant messages, so the tail element keeps changing identity and its length is not monotonic; sampling only the tail reads those handovers as resets and reports almost no growth. `sampleStreamFrames` does this correctly.
