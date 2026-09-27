import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";
import {
  buildCodeBlockStreamText,
  MOCK_LOAD_TEST_DEFAULT_MODEL_ID,
  MockLoadTestAgentClient,
  parseCodeBlockStreamPrompt,
} from "./mock-load-test-agent.js";

type PermissionRequestedEvent = Extract<AgentStreamEvent, { type: "permission_requested" }>;

function expectSinglePermissionRequest(events: AgentStreamEvent[]): PermissionRequestedEvent {
  const permissions = events.filter(
    (event): event is PermissionRequestedEvent => event.type === "permission_requested",
  );
  expect(permissions).toHaveLength(1);
  const [permission] = permissions;
  if (!permission) {
    throw new Error("permission request missing");
  }
  return permission;
}

describe("MockLoadTestAgentClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("default model is a five minute foreground stream with token-rate intervals", async () => {
    const client = new MockLoadTestAgentClient();

    const { models } = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/mock-models",
      force: false,
    });

    expect(models[0]).toMatchObject({
      id: MOCK_LOAD_TEST_DEFAULT_MODEL_ID,
      isDefault: true,
      metadata: {
        durationMs: 300_000,
        intervalMs: 40,
      },
    });
  });

  test("rejects the configured number of prompts before starting a retry", async () => {
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
      featureValues: { mockPromptRejections: 1 },
    });

    await expect(session.startTurn("Reject this prompt.")).rejects.toThrow(
      "Requested mock prompt rejection",
    );

    await expect(session.startTurn("Accept this retry.")).resolves.toEqual({
      turnId: expect.any(String),
    });
    await session.interrupt();
  });

  test("streams a configured assistant response through the normal timeline", async () => {
    vi.useFakeTimers();
    const response = [
      "```mermaid",
      "flowchart LR",
      "  Start --> Middle",
      '  Middle --> End["<i>Done</i>"]',
      "```",
    ].join("\n");
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
      featureValues: {
        mockStreamingAssistantResponse: response,
        mockStreamingAssistantIntervalMs: 20,
      },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const resultPromise = session.run("Render a diagram while streaming.");
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({ finalText: response, canceled: false });
    const streamedText = events
      .flatMap((event) =>
        event.type === "timeline" && event.item.type === "assistant_message"
          ? [event.item.text]
          : [],
      )
      .join("");
    expect(streamedText).toBe(response);
    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "assistant_message")
        .length,
    ).toBeGreaterThan(5);
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", provider: "mock" });
  });

  test("streams prose and TypeScript code blocks as sub-word tokens selected by prompt", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const assistantChunks = () =>
      events.flatMap((event) =>
        event.type === "timeline" && event.item.type === "assistant_message"
          ? [event.item.text]
          : [],
      );

    const resultPromise = session.run("Stream 3 code blocks of 22 lines every 5 ms.");
    await vi.advanceTimersByTimeAsync(0);
    const afterFirstToken = assistantChunks().length;
    await vi.advanceTimersByTimeAsync(4);
    expect(assistantChunks()).toHaveLength(afterFirstToken);
    await vi.advanceTimersByTimeAsync(1);
    expect(assistantChunks()).toHaveLength(afterFirstToken + 1);
    await vi.runAllTimersAsync();

    const text = assistantChunks().join("");
    await expect(resultPromise).resolves.toMatchObject({ finalText: text, canceled: false });
    expect(text).toBe(buildCodeBlockStreamText({ blocks: 3, linesPerBlock: 22, intervalMs: 5 }));
    const blocks = Array.from(text.matchAll(/```ts\n([\s\S]*?)\n```/g), (match) => match[1] ?? "");
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.split("\n").length)).toEqual([22, 22, 22]);
    expect(blocks[0]).toContain("\n\nexport async function loadSection1Batch2(");
    expect(text.startsWith("Section 1 of 3 wires the batch loader")).toBe(true);
    expect(Math.max(...assistantChunks().map((chunk) => chunk.trim().length))).toBeLessThanOrEqual(
      5,
    );
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", provider: "mock" });
  });

  test("code block stream prompt falls back to defaults and caps its sizes", () => {
    expect(parseCodeBlockStreamPrompt("Stream code blocks.")).toEqual({
      blocks: 20,
      linesPerBlock: 40,
      intervalMs: 20,
    });
    expect(parseCodeBlockStreamPrompt("Stream 7 code blocks every 3 ms.")).toEqual({
      blocks: 7,
      linesPerBlock: 40,
      intervalMs: 3,
    });
    expect(parseCodeBlockStreamPrompt("Stream 500 code blocks of 9000 lines every 1 ms.")).toEqual({
      blocks: 200,
      linesPerBlock: 400,
      intervalMs: 1,
    });
    expect(parseCodeBlockStreamPrompt("Write some code blocks.")).toBeNull();
  });

  test("can withhold the provider user-message echo until an immediate interrupt", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("Withhold synthetic user message until interrupted.", {
      clientMessageId: "client-message-1",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.some((event) => event.type === "timeline")).toBe(false);

    await session.interrupt();
    expect(events.map((event) => event.type)).toEqual(["turn_canceled"]);
  });

  test("can emit the provider user-message echo before accepting the turn", async () => {
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("Emit synthetic user message before accepting turn.", {
      clientMessageId: "client-message-1",
    });

    expect(events).toContainEqual({
      type: "timeline",
      provider: "mock",
      turnId: expect.any(String),
      item: {
        type: "user_message",
        text: "Emit synthetic user message before accepting turn.",
        messageId: expect.any(String),
        clientMessageId: "client-message-1",
      },
    });
    await session.interrupt();
  });

  test("can place the provider echo beyond a bounded timeline tail", async () => {
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.run("Emit 205 assistant messages before synthetic user message.", {
      clientMessageId: "client-message-1",
    });

    const timelineItems = events.flatMap((event) =>
      event.type === "timeline" ? [event.item] : [],
    );
    expect(timelineItems.filter((item) => item.type === "assistant_message")).toHaveLength(205);
    expect(timelineItems.at(-1)).toMatchObject({
      type: "user_message",
      clientMessageId: "client-message-1",
    });
  });

  test("returns schema-shaped JSON for structured branch-name generation", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });

    const resultPromise = session.run(
      [
        "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
        "Title: a short human-readable sentence-case label for the task (no slug rules, max 80 characters).",
        "Branch: concise lowercase slug using letters, numbers, hyphens, and slashes only.",
        "Return JSON only with fields 'title' and 'branch'.",
        "",
        "<user-prompt>",
        "Fix login bug",
        "</user-prompt>",
      ].join("\n"),
    );
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).resolves.toMatchObject({
      sessionId: session.id,
      finalText: JSON.stringify({ title: "Fix login bug", branch: "fix-login-bug" }),
      canceled: false,
    });
  });

  test("emits sub-word tokens, reasoning, and sequential tool calls during a foreground turn", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    const resultPromise = session.run("Exercise the app while terminals are busy.");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;
    unsubscribe();

    expect(
      events.map((event) => event.type).filter((type) => type === "turn_started"),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn_completed",
      provider: "mock",
    });
    expect(result).toMatchObject({
      sessionId: session.id,
      finalText: "Synthetic load test complete",
      canceled: false,
    });

    const timelineItems = events.flatMap((event): AgentTimelineItem[] =>
      event.type === "timeline" ? [event.item] : [],
    );

    const assistantTokens = timelineItems.filter((item) => item.type === "assistant_message");
    const reasoningTokens = timelineItems.filter((item) => item.type === "reasoning");
    const toolCalls = timelineItems.filter((item) => item.type === "tool_call");

    // Many small token deltas, not a few big chunks.
    expect(assistantTokens.length).toBeGreaterThan(200);
    expect(reasoningTokens.length).toBeGreaterThan(20);

    // Average token length should be sub-word (a few characters).
    const avgTokenLength =
      assistantTokens.reduce(
        (sum, item) => sum + (item.type === "assistant_message" ? item.text.length : 0),
        0,
      ) / assistantTokens.length;
    expect(avgTokenLength).toBeLessThan(10);

    // First assistant token starts the cycle header.
    expect(assistantTokens[0]).toMatchObject({
      type: "assistant_message",
      text: expect.stringContaining("##"),
    });

    // Sequential tool calls fire: read, grep, edit, bash.
    const toolNames = toolCalls
      .filter((item) => item.type === "tool_call" && item.status === "running")
      .map((item) => (item.type === "tool_call" ? item.name : ""));
    expect(toolNames.slice(0, 4)).toEqual(["read", "grep", "edit", "bash"]);

    // Each tool transitions running → completed.
    const completedNames = toolCalls
      .filter((item) => item.type === "tool_call" && item.status === "completed")
      .map((item) => (item.type === "tool_call" ? item.name : ""));
    expect(completedNames).toContain("read");
    expect(completedNames).toContain("grep");
    expect(completedNames).toContain("edit");
    expect(completedNames).toContain("bash");
  });

  test("interrupt cancels the active foreground turn and stops future chunks", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.startTurn("Cancel the synthetic stream.");
    await vi.advanceTimersByTimeAsync(0);

    await session.interrupt();
    const eventCountAfterInterrupt = events.length;
    await vi.advanceTimersByTimeAsync(10_000);
    unsubscribe();

    expect(events.at(-1)).toMatchObject({
      type: "turn_canceled",
      provider: "mock",
      reason: "Interrupted",
    });
    expect(events).toHaveLength(eventCountAfterInterrupt);
  });

  test("emits a terminal failure without an assistant provider message", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.startTurn("Emit a synthetic turn failure.");
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ type: "user_message" }),
      }),
    );
    expect(
      events.filter(
        (event) => event.type === "timeline" && event.item.type === "assistant_message",
      ),
    ).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "turn_failed",
      error: "Requested mock provider failure",
    });
  });

  test("emits turn_started before the submitted user message", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.startTurn("Order the submitted prompt.", {
      clientMessageId: "client-message-1",
    });
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();

    expect(
      events
        .slice(0, 2)
        .map((event) =>
          event.type === "timeline" ? `${event.type}:${event.item.type}` : event.type,
        ),
    ).toEqual(["turn_started", "timeline:user_message"]);
  });

  test("emits the free-write question scenario selected by prompt", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    const resultPromise = session.run("Emit synthetic questions: two free-write questions.");
    await vi.advanceTimersByTimeAsync(0);

    const permission = expectSinglePermissionRequest(events);
    expect(permission.request).toMatchObject({
      provider: "mock",
      name: "MockQuestions",
      kind: "question",
      input: {
        questions: [
          {
            question: "What is the GitHub private repo URL to push to?",
            header: "repoUrl",
            options: [],
            multiSelect: false,
          },
          {
            question: "What should the first commit message be?",
            header: "commitMessage",
            options: [],
            multiSelect: false,
          },
        ],
      },
    });

    await session.respondToPermission(permission.request.id, {
      behavior: "allow",
      updatedInput: {
        answers: {
          repoUrl: "git@github.com:user/private-repo.git",
          commitMessage: "Initialize private repo",
        },
      },
    });
    await expect(resultPromise).resolves.toMatchObject({
      sessionId: session.id,
      finalText: "Synthetic questions resolved",
      canceled: false,
    });
    unsubscribe();
  });

  test("uses one continuous assistant stream for bursty rendering measurements", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "bursty-stream",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.startTurn("Measure paced rendering.");
    await vi.advanceTimersByTimeAsync(0);

    const timelineItems = events.flatMap((event) =>
      event.type === "timeline" ? [event.item] : [],
    );
    expect(timelineItems.filter((item) => item.type === "assistant_message")).not.toHaveLength(0);
    expect(
      timelineItems.filter((item) => item.type === "reasoning" || item.type === "tool_call"),
    ).toEqual([]);
    await session.interrupt();
    unsubscribe();
  });

  test("emits a settled assistant Markdown image path selected by prompt", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    const markdown = "![Fixture image](screenshots/fixture.png)";

    const resultPromise = session.run(`Emit settled assistant image Markdown: ${markdown}`);
    await vi.advanceTimersByTimeAsync(0);

    expect(
      events.flatMap((event): AgentTimelineItem[] =>
        event.type === "timeline" && event.item.type === "assistant_message" ? [event.item] : [],
      ),
    ).toEqual([
      expect.objectContaining({
        type: "assistant_message",
        text: markdown,
      }),
    ]);
    await expect(resultPromise).resolves.toMatchObject({
      sessionId: session.id,
      finalText: markdown,
      canceled: false,
    });
    unsubscribe();
  });

  test("agent manager coalesces adjacent assistant tokens into fewer messages", async () => {
    vi.useFakeTimers();
    const workdir = mkdtempSync(join(tmpdir(), "paseo-mock-load-test-"));
    try {
      const client = new MockLoadTestAgentClient();
      const manager = new AgentManager({
        clients: { mock: client },
        idFactory: () => "00000000-0000-4000-8000-000000000001",
        logger: createTestLogger(),
      });
      const agent = await manager.createAgent(
        {
          provider: "mock",
          cwd: workdir,
          model: "ten-second-stream",
        },
        "00000000-0000-4000-8000-000000000001",
        { workspaceId: undefined },
      );

      const resultPromise = manager.runAgent(
        agent.id,
        "Stress the agent stream while terminal panes are active.",
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await resultPromise;

      const timeline = manager.getTimeline(agent.id);
      const assistantMessages = timeline.filter((item) => item.type === "assistant_message");
      const toolCalls = timeline.filter((item) => item.type === "tool_call");

      // The provider streams sub-word tokens; the coalescer batches them within
      // its flush window, so the timeline must contain materially fewer messages
      // than the underlying token deltas would suggest, and each message must
      // hold multiple tokens worth of text.
      expect(assistantMessages.length).toBeGreaterThan(0);
      const totalAssistantChars = assistantMessages.reduce(
        (sum, item) => sum + (item.type === "assistant_message" ? item.text.length : 0),
        0,
      );
      const avgMessageLength = totalAssistantChars / assistantMessages.length;
      expect(avgMessageLength).toBeGreaterThan(8);
      const longestMessage = assistantMessages
        .map((item) => (item.type === "assistant_message" ? item.text.length : 0))
        .reduce((max, length) => Math.max(max, length), 0);
      expect(longestMessage).toBeGreaterThan(20);

      // The cycle header is at the start of the stream. It can straddle the first
      // two messages, because the coalescer flushes the leading token of a burst
      // on its own before batching the rest.
      const assistantText = assistantMessages
        .map((item) => (item.type === "assistant_message" ? item.text : ""))
        .join("");
      expect(assistantText).toContain("## Cycle 1");

      // Tool calls land in expected order at least once.
      const runningTools = toolCalls
        .filter((item) => item.type === "tool_call" && item.status === "completed")
        .map((item) => (item.type === "tool_call" ? item.name : ""));
      expect(runningTools).toEqual(expect.arrayContaining(["read", "grep", "edit", "bash"]));
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("agent manager delivers the code block stream by paragraph when configured", async () => {
    vi.useFakeTimers();
    const workdir = mkdtempSync(join(tmpdir(), "paseo-mock-load-test-"));
    try {
      const agentId = "00000000-0000-4000-8000-000000000001";
      const manager = new AgentManager({
        clients: { mock: new MockLoadTestAgentClient() },
        idFactory: () => agentId,
        logger: createTestLogger(),
        assistantTextDelivery: "paragraph",
      });
      const deliveries: string[] = [];
      manager.subscribe(
        (event) => {
          if (
            event.type === "agent_stream" &&
            event.event.type === "timeline" &&
            event.event.item.type === "assistant_message"
          ) {
            deliveries.push(event.event.item.text);
          }
        },
        { replayState: false },
      );
      await manager.createAgent(
        { provider: "mock", cwd: workdir, model: "ten-second-stream" },
        agentId,
        { workspaceId: undefined },
      );

      const resultPromise = manager.runAgent(
        agentId,
        "Stream 4 code blocks of 30 lines every 5 ms.",
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await resultPromise;

      expect(deliveries.join("")).toBe(
        buildCodeBlockStreamText({ blocks: 4, linesPerBlock: 30, intervalMs: 5 }),
      );
      // Every delivery ends a paragraph or a code block, and none ends inside a
      // fence: clients only ever receive finished Markdown blocks.
      let delivered = "";
      for (const text of deliveries) {
        delivered += text;
        expect(text.endsWith("\n\n") || text.endsWith("```\n")).toBe(true);
        expect((delivered.match(/^```/gm) ?? []).length % 2).toBe(0);
      }
      // At 5ms per token each block takes far longer than the pacing interval,
      // so every prose paragraph and every code block lands as one delivery.
      expect(deliveries).toHaveLength(2 * 4);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
