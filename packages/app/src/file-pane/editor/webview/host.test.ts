import { describe, expect, it } from "vitest";
import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import { ManualClock } from "@/test/manual-clock";
import type { EditorVisualTheme } from "../extensions.web";
import { FileEditorModel, type FileEditorFile, type FileEditorSession } from "../model";
import { encodeFrames, FrameAssembler } from "./frames";
import { FileEditorWebViewHost, type EditorConfiguration } from "./host";
import type { EditorEvent, EditorFindState, EditorHostMessage } from "./protocol";

const THEME: EditorVisualTheme = {
  colorScheme: "dark",
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
  foregroundMuted: "#999999",
  border: "#333333",
  selection: "#444444",
  monoFont: "monospace",
  codeFontSize: 13,
  syntax: {} as EditorVisualTheme["syntax"],
};

const CONFIGURATION: EditorConfiguration = {
  filename: "src/app.ts",
  theme: THEME,
  vimEnabled: false,
};

class RecordingSession implements FileEditorSession {
  writes: string[] = [];

  async write(input: { content: string }): Promise<FileWriteResult> {
    this.writes.push(input.content);
    return {
      status: "written",
      modifiedAt: "2026-09-23T00:00:01.000Z",
      size: input.content.length,
    };
  }
}

/** Stands in for the WebView page: decodes what the host posts and posts events back. */
class FakePage {
  readonly received: EditorHostMessage[] = [];
  private readonly assembler = new FrameAssembler();
  private nextId = 1;
  host: FileEditorWebViewHost | null = null;

  deliver = (frame: string): void => {
    const message = this.assembler.receive(frame);
    if (message !== undefined) this.received.push(message as EditorHostMessage);
  };

  post(event: EditorEvent, dataLength?: number): void {
    for (const frame of encodeFrames({ message: event, id: this.nextId++, dataLength })) {
      this.host?.receive(frame);
    }
  }

  take(): EditorHostMessage[] {
    return this.received.splice(0);
  }
}

function version(content: string, modifiedAt = "2026-09-23T00:00:00.000Z") {
  return {
    status: "ready",
    cwd: "/workspace",
    path: "src/app.ts",
    size: content.length,
    modifiedAt,
  } satisfies Extract<FileVersion, { status: "ready" }>;
}

function diskFile(content: string, modifiedAt?: string): FileEditorFile {
  return { content, hasBom: false, version: version(content, modifiedAt) };
}

function setup(content = "one\ntwo\n") {
  const clock = new ManualClock();
  const session = new RecordingSession();
  const model = new FileEditorModel({ file: diskFile(content), session, clock });
  const page = new FakePage();
  const cursor: Array<{ line: number; column: number }> = [];
  const vimModes: Array<string | null> = [];
  const host = new FileEditorWebViewHost({
    model,
    configuration: CONFIGURATION,
    callbacks: {
      onCursorChange: (position) => cursor.push(position),
      onVimModeChange: (mode) => vimModes.push(mode),
    },
    send: page.deliver,
    clock,
    readyTimeoutMs: 5_000,
    flushTimeoutMs: 1_000,
  });
  page.host = host;
  const detach = host.attach();
  return { clock, session, model, page, host, detach, cursor, vimModes };
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
  const pending = Symbol("pending");
  return (await Promise.race([promise, Promise.resolve(pending)])) !== pending;
}

function startEditor(page: FakePage) {
  page.post({ type: "bridgeReady" });
  page.post({ type: "editorReady" });
  return page.take();
}

describe("FileEditorWebViewHost", () => {
  it("configures the page and loads the document once the bridge is ready", () => {
    const { page, host } = setup("a\r\nb\r\n");
    expect(page.take()).toEqual([]);
    page.post({ type: "bridgeReady" });
    expect(page.take()).toEqual([
      { type: "configure", ...CONFIGURATION },
      { type: "load", revision: 1, content: "a\r\nb\r\n", lineSeparator: "\r\n" },
    ]);
    expect(host.getState().status).toBe("loading");
    page.post({ type: "editorReady" });
    expect(host.getState().status).toBe("ready");
  });

  it("fails when the editor does not report ready in time, and stays failed", () => {
    const { clock, page, host } = setup();
    page.post({ type: "bridgeReady" });
    clock.advance(4_999);
    expect(host.getState().status).toBe("loading");
    clock.advance(1);
    expect(host.getState().status).toBe("failed");
    page.post({ type: "editorReady" });
    expect(host.getState().status).toBe("failed");
  });

  it("applies page edits to the model without echoing them back", () => {
    const { page, model } = setup();
    startEditor(page);
    page.post({ type: "edit", revision: 1, content: "one\ntwo\nthree\n" });
    expect(model.getSnapshot()).toMatchObject({
      content: "one\ntwo\nthree\n",
      status: "dirty",
      modified: true,
    });
    expect(page.take()).toEqual([]);
  });

  it("autosaves page edits through the model", async () => {
    const { clock, page, session } = setup();
    startEditor(page);
    page.post({ type: "edit", revision: 1, content: "edited\n" });
    clock.advance(800);
    await Promise.resolve();
    expect(session.writes).toEqual(["edited\n"]);
  });

  it("reassembles a large edit sent in many frames", () => {
    const { page, model } = setup();
    startEditor(page);
    const content = "let line = 1;\n".repeat(10_000);
    page.post({ type: "edit", revision: 1, content }, 1_000);
    expect(model.getSnapshot().content).toBe(content);
  });

  it("pushes an external change as a new revision and drops edits typed against the old one", () => {
    const { page, model } = setup("one\n");
    startEditor(page);
    model.receiveFileObservation({
      status: "ready",
      file: diskFile("from disk\n", "2026-09-23T00:00:05.000Z"),
    });
    expect(page.take()).toEqual([
      { type: "load", revision: 2, content: "from disk\n", lineSeparator: "\n" },
    ]);
    page.post({ type: "edit", revision: 1, content: "one\ntyped\n" });
    expect(model.getSnapshot()).toMatchObject({ content: "from disk\n", status: "clean" });
    page.post({ type: "edit", revision: 2, content: "from disk\ntyped\n" });
    expect(model.getSnapshot()).toMatchObject({ content: "from disk\ntyped\n", status: "dirty" });
  });

  it("keeps local edits and reports a conflict when a dirty file changes on disk", () => {
    const { page, model } = setup("one\n");
    startEditor(page);
    page.post({ type: "edit", revision: 1, content: "one\nmine\n" });
    model.receiveFileObservation({
      status: "ready",
      file: diskFile("theirs\n", "2026-09-23T00:00:05.000Z"),
    });
    expect(model.getSnapshot()).toMatchObject({ content: "one\nmine\n", status: "conflict" });
    expect(page.take()).toEqual([]);
  });

  it("reloads the disk version into the page after the user chooses Reload", async () => {
    const { page, model } = setup("one\n");
    startEditor(page);
    page.post({ type: "edit", revision: 1, content: "one\nmine\n" });
    model.receiveFileObservation({
      status: "ready",
      file: diskFile("theirs\n", "2026-09-23T00:00:05.000Z"),
    });
    await model.reload();
    expect(page.take()).toEqual([
      { type: "load", revision: 2, content: "theirs\n", lineSeparator: "\n" },
    ]);
  });

  it("resolves a flush after the page posts its pending edits", async () => {
    const { page, host, model } = setup();
    startEditor(page);
    const flush = host.flush({ final: true });
    expect(page.take()).toEqual([{ type: "flush", requestId: 1, final: true }]);
    expect(await isSettled(flush)).toBe(false);
    page.post({ type: "edit", revision: 1, content: "last keystroke\n" });
    page.post({ type: "flushed", requestId: 1 });
    expect(await isSettled(flush)).toBe(true);
    expect(model.getSnapshot().content).toBe("last keystroke\n");
  });

  it("resolves a flush after the timeout when the page never answers", async () => {
    const { clock, page, host } = setup();
    startEditor(page);
    const flush = host.flush({ final: false });
    clock.advance(999);
    expect(await isSettled(flush)).toBe(false);
    clock.advance(1);
    expect(await isSettled(flush)).toBe(true);
  });

  it("resolves flushes immediately before the editor is ready and on detach", async () => {
    const { page, host, detach } = setup();
    await host.flush({ final: false });
    expect(page.take()).toEqual([]);
    startEditor(page);
    const pending = host.flush({ final: false });
    detach();
    expect(await isSettled(pending)).toBe(true);
  });

  it("saves when the page asks to save", async () => {
    const { page, session } = setup();
    startEditor(page);
    page.post({ type: "edit", revision: 1, content: "saved by Mod-s\n" });
    page.post({ type: "save" });
    await Promise.resolve();
    expect(session.writes).toEqual(["saved by Mod-s\n"]);
  });

  it("forwards cursor, Vim mode, and Find state from the page", () => {
    const { page, host, cursor, vimModes } = setup();
    startEditor(page);
    const find: EditorFindState = {
      open: true,
      placement: "bottom",
      query: "two",
      replacement: "",
      current: 1,
      total: 3,
      limited: false,
      readOnly: false,
    };
    page.post({ type: "cursor", line: 2, column: 4 });
    page.post({ type: "vimMode", mode: "INSERT" });
    page.post({ type: "find", state: find });
    expect(cursor).toEqual([{ line: 2, column: 4 }]);
    expect(vimModes).toEqual(["INSERT"]);
    expect(host.getState().find).toEqual(find);
  });

  it("ignores malformed events", () => {
    const { page, host, model } = setup();
    startEditor(page);
    host.receive("garbage");
    host.receive(JSON.stringify({ id: 99, index: 0, count: 1, data: '{"type":"edit"}' }));
    host.receive(
      JSON.stringify({
        id: 100,
        index: 0,
        count: 1,
        data: '{"type":"cursor","line":0,"column":1}',
      }),
    );
    expect(model.getSnapshot().content).toBe("one\ntwo\n");
    expect(host.getState().status).toBe("ready");
  });

  it("sends configuration changes only when something changed", () => {
    const { page, host } = setup();
    startEditor(page);
    host.configure({ ...CONFIGURATION });
    expect(page.take()).toEqual([]);
    host.configure({ ...CONFIGURATION, vimEnabled: true });
    expect(page.take()).toEqual([{ type: "configure", ...CONFIGURATION, vimEnabled: true }]);
  });

  it("holds a line reveal until the document is loaded", () => {
    const { page, host } = setup();
    host.reveal({ lineStart: 2, lineEnd: 2 });
    expect(page.take()).toEqual([]);
    page.post({ type: "bridgeReady" });
    expect(page.take().map((message) => message.type)).toEqual(["configure", "load", "reveal"]);
  });

  it("forwards Find commands only while the editor is ready", () => {
    const { page, host } = setup();
    host.find("open");
    expect(page.take()).toEqual([]);
    startEditor(page);
    host.find("open");
    host.setFindQuery("two");
    host.setFindReplacement("2");
    host.setFindWidget({ width: 320, height: 44 });
    host.find("replaceAll");
    expect(page.take()).toEqual([
      { type: "find", action: "open" },
      { type: "findQuery", query: "two" },
      { type: "findReplacement", replacement: "2" },
      { type: "findWidget", width: 320, height: 44 },
      { type: "find", action: "replaceAll" },
    ]);
  });
});
