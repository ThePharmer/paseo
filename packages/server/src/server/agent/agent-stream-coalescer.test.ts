import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentProvider, AgentStreamEvent } from "./agent-sdk-types.js";
import {
  AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
  AgentStreamCoalescer,
  PARAGRAPH_DELIVERY_MAX_HELD_CHARS,
  PARAGRAPH_DELIVERY_MIN_INTERVAL_MS,
  type AgentStreamCoalescerFlush,
  type AgentStreamCoalescerTimers,
} from "./agent-stream-coalescer.js";
import type { AssistantTextDelivery } from "../persisted-config.js";

function createHarness(windowMs?: number, assistantTextDelivery?: AssistantTextDelivery) {
  const flushes: AgentStreamCoalescerFlush[] = [];
  const timers: AgentStreamCoalescerTimers = {
    setTimeout,
    clearTimeout,
  };
  const coalescer = new AgentStreamCoalescer({
    ...(windowMs !== undefined ? { windowMs } : {}),
    ...(assistantTextDelivery !== undefined ? { assistantTextDelivery } : {}),
    timers,
    onFlush: (payload) => {
      flushes.push(payload);
    },
  });

  return { coalescer, flushes };
}

// Consume the leading-edge flush for an agent and clear it from the record, so a
// test can assert trailing-window batching on its own. Leaves the coalescer
// inside the window, which is where the trailing timer governs.
function primeLeadingEdge(
  coalescer: AgentStreamCoalescer,
  flushes: AgentStreamCoalescerFlush[],
  agentId = "agent-1",
): void {
  coalescer.handle(agentId, assistant("prime"));
  const index = flushes.findIndex(
    (flush) => flush.agentId === agentId && flush.item.type === "assistant_message",
  );
  if (index === -1) {
    throw new Error(`expected a leading-edge flush for ${agentId}`);
  }
  flushes.splice(index, 1);
}

function timeline(
  item: Extract<AgentStreamEvent, { type: "timeline" }>["item"],
  options?: {
    provider?: AgentProvider;
    turnId?: string;
  },
): Extract<AgentStreamEvent, { type: "timeline" }> {
  return {
    type: "timeline",
    item,
    provider: options?.provider ?? "codex",
    ...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
  };
}

function assistant(
  text: string,
  options?: {
    provider?: AgentProvider;
    turnId?: string;
    messageId?: string;
  },
): Extract<AgentStreamEvent, { type: "timeline" }> {
  return timeline(
    {
      type: "assistant_message",
      text,
      ...(options?.messageId !== undefined ? { messageId: options.messageId } : {}),
    },
    options,
  );
}

function reasoning(
  text: string,
  options?: {
    provider?: AgentProvider;
    turnId?: string;
  },
): Extract<AgentStreamEvent, { type: "timeline" }> {
  return timeline({ type: "reasoning", text }, options);
}

function toolCall(options?: {
  callId?: string;
  status?: "running" | "completed" | "failed" | "canceled";
  output?: string;
  provider?: AgentProvider;
  turnId?: string;
  error?: unknown;
}): Extract<AgentStreamEvent, { type: "timeline" }> {
  const status = options?.status ?? "running";
  return timeline(
    {
      type: "tool_call",
      callId: options?.callId ?? "tool-1",
      name: "shell",
      status,
      error: status === "failed" ? (options?.error ?? "failed") : null,
      detail: {
        type: "shell",
        command: "printf ok",
        output: options?.output ?? "",
        exitCode: status === "completed" ? 0 : null,
      },
    },
    options,
  );
}

describe("AgentStreamCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("flushes the first chunk of a burst on the leading edge", () => {
    const { coalescer, flushes } = createHarness();

    expect(coalescer.handle("agent-1", assistant("hel"))).toBe(true);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "hel" },
        provider: "codex",
      },
    ]);
  });

  test("coalesces the rest of a burst until the configured window elapses", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    expect(coalescer.handle("agent-1", assistant("hel"))).toBe(true);
    expect(coalescer.handle("agent-1", assistant("lo"))).toBe(true);

    expect(flushes).toEqual([]);
    await vi.advanceTimersByTimeAsync(59);
    expect(flushes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "hello" },
        provider: "codex",
      },
    ]);
  });

  test("leads again after an idle window", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("first"));
    expect(flushes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60);
    coalescer.handle("agent-1", assistant("second"));

    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", text: "first" },
      { type: "assistant_message", text: "second" },
    ]);
  });

  test("uses constructor windowMs instead of a hard-coded value", async () => {
    const { coalescer, flushes } = createHarness(10);

    expect(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS).toBe(60);
    primeLeadingEdge(coalescer, flushes);
    expect(coalescer.handle("agent-1", assistant("fast"))).toBe(true);

    await vi.advanceTimersByTimeAsync(9);
    expect(flushes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "fast" },
        provider: "codex",
      },
    ]);
  });

  test("flushFor drains pending coalesced events", () => {
    const { coalescer, flushes } = createHarness();

    expect(coalescer.handle("agent-1", assistant("before"))).toBe(true);
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "before" },
        provider: "codex",
      },
    ]);
    expect(coalescer.handle("agent-1", toolCall())).toBe(true);
  });

  test("does not consume non-chunkable events", () => {
    const { coalescer, flushes } = createHarness();
    const nonChunkableEvents: AgentStreamEvent[] = [
      timeline({ type: "todo", items: [{ text: "ship it", completed: false }] }),
      timeline({ type: "user_message", text: "hi", messageId: "message-1" }),
      timeline({ type: "error", message: "boom" }),
      timeline({ type: "compaction", status: "loading", trigger: "auto" }),
      { type: "thread_started", provider: "codex", sessionId: "session-1" },
      { type: "turn_started", provider: "codex", turnId: "turn-1" },
      { type: "turn_completed", provider: "codex", turnId: "turn-1" },
      { type: "turn_failed", provider: "codex", error: "failed", turnId: "turn-1" },
      { type: "turn_canceled", provider: "codex", reason: "canceled", turnId: "turn-1" },
      { type: "usage_updated", provider: "codex", usage: { inputTokens: 1 }, turnId: "turn-1" },
      {
        type: "permission_requested",
        provider: "codex",
        turnId: "turn-1",
        request: {
          id: "permission-1",
          provider: "codex",
          name: "shell",
          kind: "tool",
        },
      },
      {
        type: "permission_resolved",
        provider: "codex",
        turnId: "turn-1",
        requestId: "permission-1",
        resolution: { behavior: "allow" },
      },
      {
        type: "attention_required",
        provider: "codex",
        reason: "permission",
        timestamp: "2026-04-18T00:00:00.000Z",
      },
    ];

    for (const event of nonChunkableEvents) {
      expect(coalescer.handle("agent-1", event)).toBe(false);
    }
    expect(flushes).toEqual([]);
  });

  test("preserves kind boundaries", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a1"));
    coalescer.handle("agent-1", reasoning("r1"));
    coalescer.handle("agent-1", assistant("a2"));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "a1" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "reasoning", text: "r1" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "a2" },
        provider: "codex",
      },
    ]);
  });

  test("preserves strict alternating assistant/reasoning order", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a1"));
    coalescer.handle("agent-1", reasoning("r1"));
    coalescer.handle("agent-1", assistant("a2"));
    coalescer.handle("agent-1", reasoning("r2"));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", text: "a1" },
      { type: "reasoning", text: "r1" },
      { type: "assistant_message", text: "a2" },
      { type: "reasoning", text: "r2" },
    ]);
  });

  test("does not collapse across provider boundaries", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("c", { provider: "codex" }));
    coalescer.handle("agent-1", assistant("o", { provider: "opencode" }));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "c" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "o" },
        provider: "opencode",
      },
    ]);
  });

  test("does not collapse across turnId boundaries", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("one", { turnId: "turn-1" }));
    coalescer.handle("agent-1", assistant("two", { turnId: "turn-2" }));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "one" },
        provider: "codex",
        turnId: "turn-1",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "two" },
        provider: "codex",
        turnId: "turn-2",
      },
    ]);
  });

  test("does not splice concurrent assistant message ids together", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("The", { turnId: "turn-1", messageId: "message-a" }));
    coalescer.handle("agent-1", assistant("0po", { turnId: "turn-1", messageId: "message-b" }));
    coalescer.handle("agent-1", assistant(" exact", { turnId: "turn-1", messageId: "message-a" }));
    coalescer.handle("agent-1", assistant("7/fr", { turnId: "turn-1", messageId: "message-b" }));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", messageId: "message-a", text: "The" },
      { type: "assistant_message", messageId: "message-b", text: "0po" },
      { type: "assistant_message", messageId: "message-a", text: " exact" },
      { type: "assistant_message", messageId: "message-b", text: "7/fr" },
    ]);
  });

  test("drops empty text chunks", async () => {
    const { coalescer, flushes } = createHarness();

    expect(coalescer.handle("agent-1", assistant(""))).toBe(true);
    expect(coalescer.handle("agent-2", reasoning(""))).toBe(true);

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([]);
  });

  test("preserves whitespace byte-exactly", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle("agent-1", assistant(" "));
    coalescer.handle("agent-1", assistant("\n"));
    coalescer.handle("agent-1", assistant("\t"));
    coalescer.handle("agent-1", assistant(" mixed \n\t whitespace "));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: {
          type: "assistant_message",
          text: " \n\t mixed \n\t whitespace ",
        },
        provider: "codex",
      },
    ]);
  });

  test("reconstructs bytes exactly for fragmented text", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);
    const text = "Hello, 世界.\nPunctuation: ,.!?;: — but JS strings stay intact.\n";
    const chunks = [
      "Hello",
      ", ",
      "世界",
      ".\n",
      "Punctuation: ,.!?;: ",
      "—",
      " but JS strings stay intact.\n",
    ];

    for (const chunk of chunks) {
      coalescer.handle("agent-1", assistant(chunk));
    }

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text },
        provider: "codex",
      },
    ]);
  });

  test("isolates buffers per agent", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes, "agent-1");
    primeLeadingEdge(coalescer, flushes, "agent-2");

    coalescer.handle("agent-1", assistant("a"));
    coalescer.handle("agent-2", assistant("x"));
    coalescer.handle("agent-1", assistant("b"));
    coalescer.handle("agent-2", assistant("y"));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "ab" },
        provider: "codex",
      },
      {
        agentId: "agent-2",
        item: { type: "assistant_message", text: "xy" },
        provider: "codex",
      },
    ]);
  });

  test("flushAll flushes every pending agent once", () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("a"));
    coalescer.handle("agent-2", assistant("b"));

    coalescer.flushAll();
    coalescer.flushAll();

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "a" },
        provider: "codex",
      },
      {
        agentId: "agent-2",
        item: { type: "assistant_message", text: "b" },
        provider: "codex",
      },
    ]);
  });

  test("flushFor is idempotent", () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("once"));
    coalescer.flushFor("agent-1");
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "once" },
        provider: "codex",
      },
    ]);
  });

  test("chunks appended during onFlush use a later buffer", async () => {
    const flushes: AgentStreamCoalescerFlush[] = [];
    let coalescer!: AgentStreamCoalescer;
    coalescer = new AgentStreamCoalescer({
      timers: {
        setTimeout,
        clearTimeout,
      },
      onFlush: (payload) => {
        flushes.push(payload);
        if (payload.agentId === "agent-1" && payload.item.text === "first") {
          coalescer.handle("agent-1", assistant("second"));
        }
      },
    });

    primeLeadingEdge(coalescer, flushes);
    coalescer.handle("agent-1", assistant("first"));
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "first" },
        provider: "codex",
      },
    ]);

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "first" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "second" },
        provider: "codex",
      },
    ]);
  });

  test("manual flush prevents late duplicate output after timers advance", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("manual"));
    coalescer.flushFor("agent-1");

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "manual" },
        provider: "codex",
      },
    ]);
  });

  test("flushAndDiscard flushes, clears timer, and invalidates stale callbacks", async () => {
    const { coalescer, flushes } = createHarness();

    coalescer.handle("agent-1", assistant("durable"));
    coalescer.flushAndDiscard("agent-1");

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "durable" },
        provider: "codex",
      },
    ]);
  });

  test("stale timers cannot flush reused agent ids", () => {
    const scheduled: Array<() => void> = [];
    const flushes: AgentStreamCoalescerFlush[] = [];
    const setTimeoutShim: AgentStreamCoalescerTimers["setTimeout"] = (callback, delay) => {
      scheduled.push(() => {
        callback();
      });
      return setTimeout(callback, delay);
    };
    const coalescer = new AgentStreamCoalescer({
      timers: {
        setTimeout: setTimeoutShim,
        clearTimeout,
      },
      onFlush: (payload) => {
        flushes.push(payload);
      },
    });

    primeLeadingEdge(coalescer, flushes);
    coalescer.handle("agent-1", assistant("old"));
    const oldTimerCallback = scheduled[0];
    coalescer.flushAndDiscard("agent-1");
    coalescer.handle("agent-1", assistant("new"));

    oldTimerCallback();
    coalescer.flushFor("agent-1");

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "old" },
        provider: "codex",
      },
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "new" },
        provider: "codex",
      },
    ]);
  });

  test("preserves first chunk item shape and replaces only text on collapse", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);
    const firstItem = {
      type: "assistant_message" as const,
      text: "he",
      futureOptionalField: { preserved: true },
    };

    coalescer.handle("agent-1", timeline(firstItem));
    coalescer.handle("agent-1", assistant("llo"));

    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: {
          type: "assistant_message",
          text: "hello",
          futureOptionalField: { preserved: true },
        },
        provider: "codex",
      },
    ]);
  });

  test("coalesces tool call updates by callId with latest snapshot winning", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    expect(coalescer.handle("agent-1", toolCall({ output: "first" }))).toBe(true);
    expect(coalescer.handle("agent-1", toolCall({ output: "second" }))).toBe(true);

    await vi.advanceTimersByTimeAsync(60);

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "shell",
            command: "printf ok",
            output: "second",
            exitCode: null,
          },
        },
        provider: "codex",
      },
    ]);
  });

  test("coalesces interleaved tool call updates independently by callId", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle("agent-1", toolCall({ callId: "tool-1", output: "one-a" }));
    coalescer.handle("agent-1", toolCall({ callId: "tool-2", output: "two-a" }));
    coalescer.handle("agent-1", toolCall({ callId: "tool-1", output: "one-b" }));
    coalescer.handle("agent-1", toolCall({ callId: "tool-2", output: "two-b" }));

    await vi.advanceTimersByTimeAsync(60);

    expect(flushes.map((flush) => flush.item)).toEqual([
      {
        type: "tool_call",
        callId: "tool-1",
        name: "shell",
        status: "running",
        error: null,
        detail: {
          type: "shell",
          command: "printf ok",
          output: "one-b",
          exitCode: null,
        },
      },
      {
        type: "tool_call",
        callId: "tool-2",
        name: "shell",
        status: "running",
        error: null,
        detail: {
          type: "shell",
          command: "printf ok",
          output: "two-b",
          exitCode: null,
        },
      },
    ]);
  });

  test("terminal tool call statuses flush immediately", () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle("agent-1", toolCall({ output: "running" }));
    expect(flushes).toEqual([]);

    expect(coalescer.handle("agent-1", toolCall({ status: "completed", output: "done" }))).toBe(
      true,
    );

    expect(flushes.map((flush) => flush.item)).toEqual([
      {
        type: "tool_call",
        callId: "tool-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: {
          type: "shell",
          command: "printf ok",
          output: "done",
          exitCode: 0,
        },
      },
    ]);
  });

  test("preserves mixed text and tool call arrival order within a flush", async () => {
    const { coalescer, flushes } = createHarness();
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle("agent-1", assistant("a"));
    coalescer.handle("agent-1", toolCall({ output: "running" }));
    coalescer.handle("agent-1", reasoning("r"));
    coalescer.handle("agent-1", toolCall({ output: "latest" }));
    coalescer.handle("agent-1", assistant("b"));

    await vi.advanceTimersByTimeAsync(60);

    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", text: "a" },
      {
        type: "tool_call",
        callId: "tool-1",
        name: "shell",
        status: "running",
        error: null,
        detail: {
          type: "shell",
          command: "printf ok",
          output: "latest",
          exitCode: null,
        },
      },
      { type: "reasoning", text: "r" },
      { type: "assistant_message", text: "b" },
    ]);
  });
});

describe("AgentStreamCoalescer paragraph delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createParagraphHarness() {
    return createHarness(undefined, "paragraph");
  }

  function assistantTexts(flushes: AgentStreamCoalescerFlush[]): string[] {
    return flushes.flatMap((flush) =>
      flush.item.type === "assistant_message" ? [flush.item.text] : [],
    );
  }

  test("token delivery flushes a partial paragraph every window", async () => {
    const { coalescer, flushes } = createHarness(undefined, "token");

    coalescer.handle("agent-1", assistant("First "));
    coalescer.handle("agent-1", assistant("half"));
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS);

    expect(assistantTexts(flushes)).toEqual(["First ", "half"]);
  });

  test("holds assistant text until a blank line ends the paragraph", async () => {
    const { coalescer, flushes } = createParagraphHarness();

    coalescer.handle("agent-1", assistant("First para"));
    coalescer.handle("agent-1", assistant("graph.\n"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flushes).toEqual([]);

    coalescer.handle("agent-1", assistant("\nSecond"));
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS);

    expect(flushes).toEqual([
      {
        agentId: "agent-1",
        item: { type: "assistant_message", text: "First paragraph.\n\n" },
        provider: "codex",
      },
    ]);

    coalescer.flushFor("agent-1");
    expect(assistantTexts(flushes)).toEqual(["First paragraph.\n\n", "Second"]);
  });

  test("holds a fenced code block across blank lines until the fence closes", async () => {
    const { coalescer, flushes } = createParagraphHarness();

    coalescer.handle("agent-1", assistant("```ts\nconst a = 1;\n\n\nconst b = 2;\n"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flushes).toEqual([]);

    coalescer.handle("agent-1", assistant("```\nAfter"));
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS);

    expect(assistantTexts(flushes)).toEqual(["```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n"]);
  });

  test("does not treat a fence line with an info string as a closing fence", async () => {
    const { coalescer, flushes } = createParagraphHarness();

    coalescer.handle("agent-1", assistant("```ts\nconst a = 1;\n```js\n\nconst b = 2;\n"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(flushes).toEqual([]);
  });

  test(`spaces releases of one message at least ${PARAGRAPH_DELIVERY_MIN_INTERVAL_MS}ms apart`, async () => {
    const { coalescer, flushes } = createParagraphHarness();

    coalescer.handle("agent-1", assistant("One.\n\n"));
    expect(assistantTexts(flushes)).toEqual(["One.\n\n"]);

    await vi.advanceTimersByTimeAsync(100);
    coalescer.handle("agent-1", assistant("Two.\n\n"));
    await vi.advanceTimersByTimeAsync(100);
    coalescer.handle("agent-1", assistant("Three.\n\nFour"));
    await vi.advanceTimersByTimeAsync(PARAGRAPH_DELIVERY_MIN_INTERVAL_MS - 201);
    expect(assistantTexts(flushes)).toEqual(["One.\n\n"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(assistantTexts(flushes)).toEqual(["One.\n\n", "Two.\n\nThree.\n\n"]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(assistantTexts(flushes)).toEqual(["One.\n\n", "Two.\n\nThree.\n\n"]);
  });

  test("releases the first paragraph of a new message without waiting for pacing", async () => {
    const { coalescer, flushes } = createParagraphHarness();

    coalescer.handle("agent-1", assistant("One.\n\n", { messageId: "m1" }));
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS);
    coalescer.handle("agent-1", assistant("Other.\n\n", { messageId: "m2" }));
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS);

    expect(assistantTexts(flushes)).toEqual(["One.\n\n", "Other.\n\n"]);
  });

  test(`releases held text past ${PARAGRAPH_DELIVERY_MAX_HELD_CHARS} characters at the last complete line`, async () => {
    const { coalescer, flushes } = createParagraphHarness();
    const line = `${"x".repeat(99)}\n`;
    const lines = line.repeat(Math.ceil(PARAGRAPH_DELIVERY_MAX_HELD_CHARS / line.length));

    coalescer.handle("agent-1", assistant(lines.slice(0, PARAGRAPH_DELIVERY_MAX_HELD_CHARS)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flushes).toEqual([]);

    coalescer.handle("agent-1", assistant(`${lines.slice(PARAGRAPH_DELIVERY_MAX_HELD_CHARS)}tail`));
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS);

    expect(assistantTexts(flushes)).toEqual([lines]);
    coalescer.flushFor("agent-1");
    expect(assistantTexts(flushes)).toEqual([lines, "tail"]);
  });

  test("keeps the rest of a code block held after a safety release inside it", async () => {
    const { coalescer, flushes } = createParagraphHarness();
    const code = `\`\`\`ts\n${"const value = 1;\n".repeat(
      Math.ceil(PARAGRAPH_DELIVERY_MAX_HELD_CHARS / 17) + 1,
    )}`;

    coalescer.handle("agent-1", assistant(code));
    expect(assistantTexts(flushes)).toEqual([code]);

    await vi.advanceTimersByTimeAsync(1_000);
    coalescer.handle("agent-1", assistant("\nconst after = 2;\n\n"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(assistantTexts(flushes)).toEqual([code]);

    coalescer.handle("agent-1", assistant("```\n"));
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS);
    expect(assistantTexts(flushes)).toEqual([code, "\nconst after = 2;\n\n```\n"]);
  });

  test("releases held text before a tool call so order is preserved", async () => {
    const { coalescer, flushes } = createParagraphHarness();

    coalescer.handle("agent-1", assistant("Let me check"));
    coalescer.handle("agent-1", toolCall({ output: "running" }));
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS);

    expect(flushes.map((flush) => flush.item.type)).toEqual(["assistant_message", "tool_call"]);
    expect(assistantTexts(flushes)).toEqual(["Let me check"]);
  });

  test("releases held text before reasoning and keeps reasoning on token delivery", async () => {
    const { coalescer, flushes } = createParagraphHarness();

    coalescer.handle("agent-1", assistant("Partial"));
    coalescer.handle("agent-1", reasoning("thinking"));
    coalescer.handle("agent-1", reasoning(" more"));
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS);

    expect(flushes.map((flush) => flush.item)).toEqual([
      { type: "assistant_message", text: "Partial" },
      { type: "reasoning", text: "thinking more" },
    ]);
  });

  test("keeps a partial paragraph held across usage updates but not across turn events", () => {
    const { coalescer, flushes } = createParagraphHarness();

    coalescer.handle("agent-1", assistant("Partial"));
    coalescer.flushBefore("agent-1", {
      type: "usage_updated",
      provider: "codex",
      usage: { contextWindowUsedTokens: 10 },
    });
    expect(flushes).toEqual([]);

    coalescer.flushBefore("agent-1", { type: "turn_completed", provider: "codex" });
    expect(assistantTexts(flushes)).toEqual(["Partial"]);
  });

  test("flushBefore releases a partial paragraph in token delivery for any event", () => {
    const { coalescer, flushes } = createHarness(undefined, "token");
    primeLeadingEdge(coalescer, flushes);

    coalescer.handle("agent-1", assistant("Partial"));
    coalescer.flushBefore("agent-1", {
      type: "usage_updated",
      provider: "codex",
      usage: { contextWindowUsedTokens: 10 },
    });

    expect(assistantTexts(flushes)).toEqual(["Partial"]);
  });

  test("flushAndDiscard releases held text", () => {
    const { coalescer, flushes } = createParagraphHarness();

    coalescer.handle("agent-1", assistant("Interrupted mid"));
    coalescer.flushAndDiscard("agent-1");

    expect(assistantTexts(flushes)).toEqual(["Interrupted mid"]);
  });
});
