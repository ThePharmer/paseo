import { describe, expect, it } from "vitest";
import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import { ManualClock } from "@/test/manual-clock";
import { FileEditorModel, type FileEditorFile, type FileEditorSession } from "./model";
import { FileEditingSession } from "./session";
import type { FileEditorViewHandle } from "./view-contract";

const KIB = 1024;

class RecordingWriter implements FileEditorSession {
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

/**
 * Stands in for the native editor view: it holds typed text the model has not seen
 * until the session asks it to flush, like the WebView page.
 */
class FakeEditorView implements FileEditorViewHandle {
  readonly calls: string[] = [];
  unposted: string | null = null;
  acceptsEdits = true;
  private pending: Array<() => void> = [];

  constructor(private readonly model: FileEditorModel) {}

  type(content: string): void {
    if (this.acceptsEdits) this.unposted = content;
  }

  flush = (): Promise<void> => {
    this.calls.push("flush");
    return this.hold();
  };

  finish = (): Promise<void> => {
    this.calls.push("finish");
    this.acceptsEdits = false;
    return this.hold();
  };

  openFind = (): void => {
    this.calls.push("openFind");
  };

  /** The page answers: post what it holds, then acknowledge. */
  answer(): void {
    if (this.unposted !== null) this.model.edit(this.unposted);
    this.unposted = null;
    for (const resolve of this.pending.splice(0)) resolve();
  }

  private hold(): Promise<void> {
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

function version(size: number): Extract<FileVersion, { status: "ready" }> {
  return {
    status: "ready",
    cwd: "/workspace",
    path: "notes.ts",
    size,
    modifiedAt: "2026-09-23T00:00:00.000Z",
  };
}

function setup(input: { platform?: "web" | "native"; content?: string } = {}) {
  const content = input.content ?? "one\n";
  const file: FileEditorFile = { content, hasBom: false, version: version(content.length) };
  const writer = new RecordingWriter();
  const clock = new ManualClock();
  const model = new FileEditorModel({ file, session: writer, clock });
  const session = new FileEditingSession({ model, platform: input.platform ?? "native" });
  const view = new FakeEditorView(model);
  return { writer, clock, model, session, view };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe("FileEditingSession", () => {
  it("opens native files in the viewer and web files in the editor", () => {
    expect(setup({ platform: "native" }).session.getSnapshot().presence).toBe("viewing");
    expect(setup({ platform: "web" }).session.getSnapshot().presence).toBe("editing");
  });

  it("applies the native size limit only when editing starts", () => {
    const { session } = setup();
    expect(session.canStart(512 * KIB + 1)).toBe(false);
    session.start(512 * KIB + 1);
    expect(session.getSnapshot().presence).toBe("viewing");

    session.start(505 * KIB);
    expect(session.getSnapshot().presence).toBe("editing");
    // Growing past the limit while editing changes nothing; Done is the only exit.
    session.start(600 * KIB);
    expect(session.getSnapshot().presence).toBe("editing");
  });

  it("keeps the editor mounted on Done until the view has handed over its last edits", async () => {
    const { session, view, model } = setup();
    session.start(10);
    session.attachSurface(view);
    view.type("one\nlast keystrokes\n");

    const done = session.finish();
    expect(view.calls).toEqual(["finish"]);
    expect(session.getSnapshot().presence).toBe("finishing");
    view.type("typed after Done\n");

    view.answer();
    await done;
    expect(session.getSnapshot().presence).toBe("viewing");
    expect(model.getSnapshot()).toMatchObject({
      content: "one\nlast keystrokes\n",
      status: "dirty",
    });
  });

  it("flushes the view before saving when the app goes to the background", async () => {
    const { session, view, writer } = setup();
    session.start(10);
    session.attachSurface(view);
    view.type("one\nbackgrounded\n");

    const backgrounded = session.background();
    await settle();
    expect(writer.writes).toEqual([]);

    view.answer();
    await backgrounded;
    expect(view.calls).toEqual(["flush"]);
    expect(writer.writes).toEqual(["one\nbackgrounded\n"]);
  });

  it("saves pending edits when the app goes to the background from the viewer", async () => {
    const { session, model, writer } = setup();
    model.edit("one\nafter Done\n");
    await session.background();
    expect(writer.writes).toEqual(["one\nafter Done\n"]);
  });

  it("saves a dirty model when the editing session closes before autosave fires", () => {
    const { session, model, writer, clock } = setup();
    session.start(10);
    model.edit("one\nunsaved\n");

    session.close();
    expect(writer.writes).toEqual(["one\nunsaved\n"]);
    clock.advance(10_000);
    expect(writer.writes).toEqual(["one\nunsaved\n"]);
  });

  it("does not save on close when a close-without-saving confirmation holds autosave", () => {
    const { session, model, writer } = setup();
    model.edit("one\ndiscarded\n");
    model.suspendAutosave();

    session.close();
    expect(writer.writes).toEqual([]);
  });

  it("stops a Done in progress from reopening the viewer once the session closes", async () => {
    const { session, view } = setup();
    session.start(10);
    session.attachSurface(view);
    const done = session.finish();
    session.close();
    view.answer();
    await done;
    expect(session.getSnapshot().presence).toBe("finishing");
  });

  it("reports readiness from the view and forgets it when the view detaches", () => {
    const { session, view } = setup();
    session.start(10);
    session.attachSurface(view);
    session.setEditorReady(true);
    expect(session.getSnapshot().editorReady).toBe(true);
    session.openFind();
    expect(view.calls).toEqual(["openFind"]);

    session.attachSurface(null);
    expect(session.getSnapshot().editorReady).toBe(false);
  });
});
