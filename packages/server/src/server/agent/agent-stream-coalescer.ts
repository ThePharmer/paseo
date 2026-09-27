import type { AgentProvider, AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";
import {
  findMarkdownParagraphBoundary,
  type MarkdownFence,
} from "./markdown-paragraph-boundary.js";
import type { AssistantTextDelivery } from "../persisted-config.js";

export const AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS = 60;

// Paragraph delivery spaces the releases of one message at least this far
// apart. Paragraphs that finish inside the interval land together on the next
// release, so a fast model does not repaint a message several times a second;
// the first paragraph of a message still lands as soon as it is finished.
export const PARAGRAPH_DELIVERY_MIN_INTERVAL_MS = 400;

// Paragraph delivery releases held text past this many characters even without
// a boundary, cut at the last complete line. A message that never writes a
// blank line or never closes its fence would otherwise stay invisible and grow
// the buffer without limit.
export const PARAGRAPH_DELIVERY_MAX_HELD_CHARS = 24 * 1024;

type CoalescableTextKind = "assistant_message" | "reasoning";
type CoalescableTimelineKind = CoalescableTextKind | "tool_call";
type CoalescableTextItem = Extract<AgentTimelineItem, { type: CoalescableTextKind }>;
type CoalescableTimelineItem = Extract<AgentTimelineItem, { type: CoalescableTimelineKind }>;
type CoalescableTimelineEvent = Extract<AgentStreamEvent, { type: "timeline" }> & {
  item: CoalescableTimelineItem;
};

export interface AgentStreamCoalescerTimers {
  setTimeout: (callback: () => void, ms?: number) => ReturnType<typeof setTimeout>;
  clearTimeout: typeof clearTimeout;
}

export interface AgentStreamCoalescerFlush {
  agentId: string;
  item: CoalescableTimelineItem;
  provider: AgentProvider;
  turnId?: string;
}

export interface AgentStreamCoalescerOptions {
  windowMs?: number;
  /**
   * `token` (default) flushes whatever assistant text arrived in each window.
   * `paragraph` holds a message's text until a paragraph or code block is
   * finished, so clients commit far fewer, larger updates.
   */
  assistantTextDelivery?: AssistantTextDelivery;
  timers: AgentStreamCoalescerTimers;
  now?: () => number;
  onFlush: (payload: AgentStreamCoalescerFlush) => void;
}

interface PendingTextEntry {
  kind: "text";
  item: CoalescableTextItem;
  text: string;
  provider: AgentProvider;
  turnId?: string;
}

interface PendingToolCallEntry {
  kind: "tool_call";
  item: Extract<AgentTimelineItem, { type: "tool_call" }>;
  provider: AgentProvider;
  turnId?: string;
}

type PendingAgentStreamEntry = PendingTextEntry | PendingToolCallEntry;

/** Paragraph delivery state for the assistant message at the tail of a buffer. */
interface HeldAssistantStream {
  messageId: string | undefined;
  provider: AgentProvider;
  turnId: string | undefined;
  /** Fence open at the start of the held text; only a safety release leaves one open. */
  openFence: MarkdownFence | null;
  lastReleaseAt: number | null;
}

interface ParagraphRelease {
  ready: string;
  rest: string;
  /** Delay until finished paragraphs held back by pacing may be released. */
  retryInMs: number | null;
}

interface PendingAgentStreamBuffer {
  agentId: string;
  entries: PendingAgentStreamEntry[];
  toolCallEntryIndexes: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  lastFlushAt: number | null;
  heldAssistant: HeldAssistantStream | null;
}

interface FlushOptions {
  /** Release all held assistant text, not only finished paragraphs. */
  releaseHeldText: boolean;
  expectedBuffer?: PendingAgentStreamBuffer;
}

function isCoalescableTimelineEvent(event: AgentStreamEvent): event is CoalescableTimelineEvent {
  return (
    event.type === "timeline" &&
    (event.item.type === "assistant_message" ||
      event.item.type === "reasoning" ||
      event.item.type === "tool_call")
  );
}

function isTextTimelineItem(item: CoalescableTimelineItem): item is CoalescableTextItem {
  return item.type === "assistant_message" || item.type === "reasoning";
}

function isTerminalToolCall(item: CoalescableTimelineItem): boolean {
  return (
    item.type === "tool_call" &&
    (item.status === "completed" || item.status === "failed" || item.status === "canceled")
  );
}

// Events that carry no timeline position. Paragraph delivery keeps a partial
// paragraph held across them instead of releasing it, since nothing a client
// renders is ordered against them. Usage updates arrive many times per message.
function isUnorderedMetadataEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "usage_updated" ||
    event.type === "thread_started" ||
    event.type === "mode_changed" ||
    event.type === "model_changed" ||
    event.type === "thinking_option_changed"
  );
}

function isAssistantTextEntry(
  entry: PendingAgentStreamEntry | undefined,
): entry is PendingTextEntry {
  return entry?.kind === "text" && entry.item.type === "assistant_message";
}

function assistantMessageId(entry: PendingTextEntry): string | undefined {
  return entry.item.type === "assistant_message" ? entry.item.messageId : undefined;
}

function isSameHeldStream(held: HeldAssistantStream, entry: PendingTextEntry): boolean {
  return (
    held.messageId === assistantMessageId(entry) &&
    held.provider === entry.provider &&
    held.turnId === entry.turnId
  );
}

function isSameTextStream(previous: PendingTextEntry, next: PendingTextEntry): boolean {
  if (previous.item.type !== next.item.type) {
    return false;
  }
  if (previous.item.type === "assistant_message" && next.item.type === "assistant_message") {
    return previous.item.messageId === next.item.messageId;
  }
  return true;
}

export class AgentStreamCoalescer {
  private readonly buffers = new Map<string, PendingAgentStreamBuffer>();
  private readonly onFlush: (payload: AgentStreamCoalescerFlush) => void;
  private readonly timers: AgentStreamCoalescerTimers;
  private readonly windowMs: number;
  private readonly assistantTextDelivery: AssistantTextDelivery;
  private readonly now: () => number;

  constructor(options: AgentStreamCoalescerOptions) {
    this.windowMs = options.windowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS;
    this.assistantTextDelivery = options.assistantTextDelivery ?? "token";
    this.timers = options.timers;
    this.now = options.now ?? Date.now;
    this.onFlush = options.onFlush;
  }

  handle(agentId: string, event: AgentStreamEvent): boolean {
    if (!isCoalescableTimelineEvent(event)) {
      return false;
    }

    if (isTextTimelineItem(event.item) && event.item.text === "") {
      return true;
    }

    const buffer = this.getOrCreateBuffer(agentId);
    // Held assistant text must land before whatever follows it, so anything but
    // more of the same message releases it now instead of waiting a window.
    if (this.holdsAssistantText(buffer) && !this.continuesHeldText(buffer, event)) {
      this.flushBuffer(agentId, { releaseHeldText: true });
    }
    this.appendToBuffer(buffer, event);

    if (isTerminalToolCall(event.item)) {
      this.flushBuffer(agentId, { releaseHeldText: true });
      return true;
    }

    // Leading edge: the first event after an idle window flushes synchronously so
    // the first token of a turn isn't delayed a full window. Sustained bursts fall
    // through to the trailing timer, which keeps the message rate at one per
    // window. Same shape as TerminalOutputCoalescer.
    if (!buffer.timer) {
      const elapsed =
        buffer.lastFlushAt === null ? Number.POSITIVE_INFINITY : this.now() - buffer.lastFlushAt;
      if (elapsed >= this.windowMs) {
        this.flushBuffer(agentId, { releaseHeldText: false });
        return true;
      }
      this.scheduleFlush(buffer, this.windowMs);
    }

    return true;
  }

  /** Flushes everything pending, including assistant text held for a paragraph boundary. */
  flushFor(agentId: string): void {
    this.flushBuffer(agentId, { releaseHeldText: true });
  }

  /**
   * Flushes pending items ahead of an event the coalescer does not own, so the
   * event lands after them. A partial paragraph stays held across events that
   * have no timeline position, such as usage updates.
   */
  flushBefore(agentId: string, event: AgentStreamEvent): void {
    this.flushBuffer(agentId, { releaseHeldText: !isUnorderedMetadataEvent(event) });
  }

  flushAll(): void {
    for (const agentId of Array.from(this.buffers.keys())) {
      this.flushBuffer(agentId, { releaseHeldText: true });
    }
  }

  flushAndDiscard(agentId: string): void {
    this.flushBuffer(agentId, { releaseHeldText: true });
    const buffer = this.buffers.get(agentId);
    if (buffer) {
      this.clearTimer(buffer);
      this.buffers.delete(agentId);
    }
  }

  private holdsAssistantText(buffer: PendingAgentStreamBuffer): boolean {
    return (
      this.assistantTextDelivery === "paragraph" && isAssistantTextEntry(buffer.entries.at(-1))
    );
  }

  private continuesHeldText(
    buffer: PendingAgentStreamBuffer,
    event: CoalescableTimelineEvent,
  ): boolean {
    const tail = buffer.entries.at(-1);
    return (
      isAssistantTextEntry(tail) &&
      event.item.type === "assistant_message" &&
      event.item.messageId === assistantMessageId(tail) &&
      event.provider === tail.provider &&
      event.turnId === tail.turnId
    );
  }

  private getOrCreateBuffer(agentId: string): PendingAgentStreamBuffer {
    const existing = this.buffers.get(agentId);
    if (existing) {
      return existing;
    }

    const buffer: PendingAgentStreamBuffer = {
      agentId,
      entries: [],
      toolCallEntryIndexes: new Map(),
      timer: null,
      flushing: false,
      lastFlushAt: null,
      heldAssistant: null,
    };
    this.buffers.set(agentId, buffer);
    return buffer;
  }

  private appendToBuffer(buffer: PendingAgentStreamBuffer, event: CoalescableTimelineEvent): void {
    if (isTextTimelineItem(event.item)) {
      buffer.entries.push({
        kind: "text",
        item: event.item,
        text: event.item.text,
        provider: event.provider,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      });
      return;
    }

    const existingIndex = buffer.toolCallEntryIndexes.get(event.item.callId);
    const entry: PendingToolCallEntry = {
      kind: "tool_call",
      item: event.item,
      provider: event.provider,
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    };

    if (existingIndex !== undefined) {
      buffer.entries[existingIndex] = entry;
      return;
    }

    buffer.toolCallEntryIndexes.set(event.item.callId, buffer.entries.length);
    buffer.entries.push(entry);
  }

  private scheduleFlush(buffer: PendingAgentStreamBuffer, delayMs: number): void {
    const timer = this.timers.setTimeout(() => {
      this.flushBuffer(buffer.agentId, { releaseHeldText: false, expectedBuffer: buffer });
    }, delayMs);
    timer.unref?.();
    buffer.timer = timer;
  }

  private clearTimer(buffer: PendingAgentStreamBuffer): void {
    if (!buffer.timer) {
      return;
    }
    this.timers.clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  private flushBuffer(agentId: string, options: FlushOptions): void {
    const buffer = this.buffers.get(agentId);
    if (!buffer) {
      return;
    }
    if (options.expectedBuffer && buffer !== options.expectedBuffer) {
      return;
    }
    if (buffer.flushing) {
      return;
    }

    this.clearTimer(buffer);
    if (buffer.entries.length === 0) {
      return;
    }

    const now = this.now();
    let emitted = this.collapseEntries(buffer.entries);
    buffer.entries = [];
    buffer.toolCallEntryIndexes.clear();
    buffer.lastFlushAt = now;

    let retryInMs: number | null = null;
    if (this.assistantTextDelivery === "paragraph") {
      const held = this.holdParagraphTail(buffer, emitted, options.releaseHeldText, now);
      emitted = held.emitted;
      retryInMs = held.retryInMs;
    }

    buffer.flushing = true;
    try {
      for (const entry of emitted) {
        this.onFlush({
          agentId,
          item:
            entry.kind === "text"
              ? {
                  ...entry.item,
                  text: entry.text,
                }
              : entry.item,
          provider: entry.provider,
          ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
        });
      }
    } finally {
      buffer.flushing = false;
    }

    if (retryInMs !== null && !buffer.timer && this.buffers.get(agentId) === buffer) {
      this.scheduleFlush(buffer, retryInMs);
    }
  }

  /**
   * Splits the collapsed batch for paragraph delivery: returns what to emit now
   * and leaves the unfinished part of a trailing assistant message in the
   * buffer. Text that is followed by anything else in the batch is always
   * emitted whole, which keeps it ahead of what follows.
   */
  private holdParagraphTail(
    buffer: PendingAgentStreamBuffer,
    collapsed: PendingAgentStreamEntry[],
    releaseHeldText: boolean,
    now: number,
  ): { emitted: PendingAgentStreamEntry[]; retryInMs: number | null } {
    const tail = collapsed.at(-1);
    if (!isAssistantTextEntry(tail)) {
      buffer.heldAssistant = null;
      return { emitted: collapsed, retryInMs: null };
    }

    const held = this.resolveHeldStream(buffer, tail);
    const release = releaseHeldText
      ? releaseAllHeldText(held, tail.text, now)
      : planParagraphRelease(held, tail.text, now);
    const emitted = collapsed.slice(0, -1);
    if (release.ready !== "") {
      emitted.push({ ...tail, text: release.ready });
    }
    if (release.rest !== "") {
      buffer.entries.push({ ...tail, text: release.rest });
    }
    return { emitted, retryInMs: release.retryInMs };
  }

  private resolveHeldStream(
    buffer: PendingAgentStreamBuffer,
    tail: PendingTextEntry,
  ): HeldAssistantStream {
    const current = buffer.heldAssistant;
    if (current && isSameHeldStream(current, tail)) {
      return current;
    }
    const next: HeldAssistantStream = {
      messageId: assistantMessageId(tail),
      provider: tail.provider,
      turnId: tail.turnId,
      openFence: null,
      lastReleaseAt: null,
    };
    buffer.heldAssistant = next;
    return next;
  }

  private collapseEntries(entries: PendingAgentStreamEntry[]): PendingAgentStreamEntry[] {
    const collapsed: PendingAgentStreamEntry[] = [];

    for (const entry of entries) {
      const previous = collapsed.at(-1);
      if (
        previous &&
        previous.kind === "text" &&
        entry.kind === "text" &&
        isSameTextStream(previous, entry) &&
        previous.provider === entry.provider &&
        previous.turnId === entry.turnId
      ) {
        previous.text += entry.text;
        continue;
      }

      collapsed.push({ ...entry });
    }

    return collapsed;
  }
}

function releaseAllHeldText(
  held: HeldAssistantStream,
  text: string,
  now: number,
): ParagraphRelease {
  held.openFence = findMarkdownParagraphBoundary(text, held.openFence).openFenceAtLastLineEnd;
  held.lastReleaseAt = now;
  return { ready: text, rest: "", retryInMs: null };
}

function planParagraphRelease(
  held: HeldAssistantStream,
  text: string,
  now: number,
): ParagraphRelease {
  const scan = findMarkdownParagraphBoundary(text, held.openFence);

  if (text.length > PARAGRAPH_DELIVERY_MAX_HELD_CHARS) {
    // Safety release: cut at the last complete line so a fence marker is never
    // split, and carry the fence state so the rest of an open block stays code.
    const cut = scan.lastLineEnd > 0 ? scan.lastLineEnd : text.length;
    held.openFence = scan.openFenceAtLastLineEnd;
    held.lastReleaseAt = now;
    return { ready: text.slice(0, cut), rest: text.slice(cut), retryInMs: null };
  }

  if (scan.boundary === -1 || text.slice(0, scan.boundary).trim() === "") {
    return { ready: "", rest: text, retryInMs: null };
  }

  const sinceLastRelease =
    held.lastReleaseAt === null ? Number.POSITIVE_INFINITY : now - held.lastReleaseAt;
  if (sinceLastRelease < PARAGRAPH_DELIVERY_MIN_INTERVAL_MS) {
    return {
      ready: "",
      rest: text,
      retryInMs: PARAGRAPH_DELIVERY_MIN_INTERVAL_MS - sinceLastRelease,
    };
  }

  // Every boundary sits outside a fence.
  held.openFence = null;
  held.lastReleaseAt = now;
  return {
    ready: text.slice(0, scan.boundary),
    rest: text.slice(scan.boundary),
    retryInMs: null,
  };
}
