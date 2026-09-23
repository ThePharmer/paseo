import type { EditorVisualTheme } from "../extensions.web";
import { systemClock, type FileEditorClock, type FileEditorModel } from "../model";
import { encodeFrames, FrameAssembler } from "./frames";
import {
  parseEditorEvent,
  type EditorEvent,
  type EditorFindAction,
  type EditorFindState,
  type EditorHostMessage,
} from "./protocol";

/** Covers bundle parse and editor startup; slow Android devices need the headroom. */
export const EDITOR_READY_TIMEOUT_MS = 8_000;
/** Done and backgrounding wait this long for the page's last edits before moving on. */
export const EDITOR_FLUSH_TIMEOUT_MS = 1_000;

export type FileEditorWebViewStatus = "loading" | "ready" | "failed";

export interface FileEditorWebViewState {
  status: FileEditorWebViewStatus;
  find: EditorFindState;
}

export interface EditorConfiguration {
  filename: string;
  theme: EditorVisualTheme;
  vimEnabled: boolean;
}

export interface FileEditorWebViewCallbacks {
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
}

const CLOSED_FIND: EditorFindState = {
  open: false,
  placement: "top",
  query: "",
  replacement: "",
  current: 0,
  total: 0,
  limited: false,
  readOnly: false,
};

/**
 * The app side of the CodeMirror WebView. The page owns local edits and posts the
 * document back paced by its outbox; this host feeds them to `FileEditorModel` and
 * pushes a new document into the page only when the model's content changes for
 * any other reason (reload, a clean file changing on disk). It never mirrors an
 * edit back to the page, which is what resets the caret in naive bridges.
 */
export class FileEditorWebViewHost {
  private readonly model: FileEditorModel;
  private readonly callbacks: FileEditorWebViewCallbacks;
  private readonly sendFrame: (frame: string) => void;
  private readonly clock: FileEditorClock;
  private readonly readyTimeoutMs: number;
  private readonly flushTimeoutMs: number;
  private readonly assembler = new FrameAssembler();
  private readonly listeners = new Set<() => void>();
  private readonly pendingFlushes = new Map<
    number,
    { resolve(): void; timer: ReturnType<typeof setTimeout> }
  >();
  private state: FileEditorWebViewState = { status: "loading", find: CLOSED_FIND };
  private configuration: EditorConfiguration;
  private bridgeReady = false;
  private revision = 0;
  private knownContent: string | null = null;
  private pendingReveal: EditorHostMessage | null = null;
  private nextFrameId = 1;
  private nextFlushId = 1;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: {
    model: FileEditorModel;
    configuration: EditorConfiguration;
    callbacks: FileEditorWebViewCallbacks;
    send(frame: string): void;
    clock?: FileEditorClock;
    readyTimeoutMs?: number;
    flushTimeoutMs?: number;
  }) {
    this.model = input.model;
    this.configuration = input.configuration;
    this.callbacks = input.callbacks;
    this.sendFrame = input.send;
    this.clock = input.clock ?? systemClock;
    this.readyTimeoutMs = input.readyTimeoutMs ?? EDITOR_READY_TIMEOUT_MS;
    this.flushTimeoutMs = input.flushTimeoutMs ?? EDITOR_FLUSH_TIMEOUT_MS;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): FileEditorWebViewState => this.state;

  /** Starts the ready deadline and follows the model. Returns the matching teardown. */
  attach(): () => void {
    if (this.state.status === "loading") {
      this.readyTimer = this.clock.setTimeout(() => {
        this.readyTimer = null;
        if (this.state.status === "loading") this.setState({ ...this.state, status: "failed" });
      }, this.readyTimeoutMs);
    }
    const unsubscribe = this.model.subscribe(this.followModel);
    return () => {
      unsubscribe();
      if (this.readyTimer) this.clock.clearTimeout(this.readyTimer);
      this.readyTimer = null;
      for (const requestId of this.pendingFlushes.keys()) this.settleFlush(requestId);
    };
  }

  receive(frame: string): void {
    const event = parseEditorEvent(this.assembler.receive(frame));
    if (event) this.handle(event);
  }

  configure(configuration: EditorConfiguration): void {
    const current = this.configuration;
    if (
      current.filename === configuration.filename &&
      current.theme === configuration.theme &&
      current.vimEnabled === configuration.vimEnabled
    ) {
      return;
    }
    this.configuration = configuration;
    if (this.bridgeReady) this.post({ type: "configure", ...configuration });
  }

  reveal(range: { lineStart: number; lineEnd: number }): void {
    const message: EditorHostMessage = { type: "reveal", ...range };
    if (this.bridgeReady) this.post(message);
    else this.pendingReveal = message;
  }

  find(action: EditorFindAction): void {
    if (this.state.status === "ready") this.post({ type: "find", action });
  }

  setFindQuery(query: string): void {
    if (this.state.status === "ready") this.post({ type: "findQuery", query });
  }

  setFindReplacement(replacement: string): void {
    if (this.state.status === "ready") this.post({ type: "findReplacement", replacement });
  }

  setFindWidget(size: { width: number; height: number }): void {
    if (this.state.status === "ready") this.post({ type: "findWidget", ...size });
  }

  /** Resolves once the page has posted every edit it holds, or after the flush timeout. */
  flush(): Promise<void> {
    if (this.state.status !== "ready") return Promise.resolve();
    const requestId = this.nextFlushId++;
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => this.settleFlush(requestId), this.flushTimeoutMs);
      this.pendingFlushes.set(requestId, { resolve, timer });
      this.post({ type: "flush", requestId });
    });
  }

  private handle(event: EditorEvent): void {
    switch (event.type) {
      case "bridgeReady":
        this.startDocument();
        return;
      case "editorReady":
        if (this.state.status !== "loading") return;
        if (this.readyTimer) this.clock.clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.setState({ ...this.state, status: "ready" });
        return;
      case "edit":
        if (event.revision !== this.revision) return;
        this.knownContent = event.content;
        this.model.edit(event.content);
        return;
      case "flushed":
        this.settleFlush(event.requestId);
        return;
      case "save":
        void this.model.save();
        return;
      case "cursor":
        this.callbacks.onCursorChange({ line: event.line, column: event.column });
        return;
      case "vimMode":
        this.callbacks.onVimModeChange(event.mode);
        return;
      case "find":
        this.setState({ ...this.state, find: event.state });
        return;
    }
  }

  private startDocument(): void {
    this.bridgeReady = true;
    this.post({ type: "configure", ...this.configuration });
    this.pushDocument();
    if (this.pendingReveal) this.post(this.pendingReveal);
    this.pendingReveal = null;
  }

  private followModel = (): void => {
    if (!this.bridgeReady || this.model.getSnapshot().content === this.knownContent) return;
    this.pushDocument();
  };

  private pushDocument(): void {
    const { content, lineSeparator } = this.model.getSnapshot();
    this.revision += 1;
    this.knownContent = content;
    this.post({ type: "load", revision: this.revision, content, lineSeparator });
  }

  private settleFlush(requestId: number): void {
    const pending = this.pendingFlushes.get(requestId);
    if (!pending) return;
    this.pendingFlushes.delete(requestId);
    this.clock.clearTimeout(pending.timer);
    pending.resolve();
  }

  private post(message: EditorHostMessage): void {
    for (const frame of encodeFrames({ message, id: this.nextFrameId++ })) this.sendFrame(frame);
  }

  private setState(state: FileEditorWebViewState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
