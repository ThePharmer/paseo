import { userEvent } from "@vitest/browser/context";
import { afterEach, expect, test } from "vitest";
import type { EditorVisualTheme } from "../extensions.web";
import { encodeFrames, FrameAssembler } from "./frames";
import { fileEditorWebViewHtml } from "./html.gen";
import type { EditorEvent, EditorHostMessage } from "./protocol";

interface EditorFrameWindow extends Window {
  __PASEO_FILE_EDITOR_RECEIVE__(frame: string): void;
}

const THEME: EditorVisualTheme = {
  colorScheme: "light",
  background: "#ffffff",
  foreground: "#111111",
  cursor: "#111111",
  foregroundMuted: "#666666",
  border: "#dddddd",
  selection: "#cce0ff",
  monoFont: "monospace",
  codeFontSize: 13,
  syntax: {} as EditorVisualTheme["syntax"],
};

let frame: HTMLIFrameElement;
afterEach(() => frame?.remove());

function openEditorPage() {
  const events: EditorEvent[] = [];
  const assembler = new FrameAssembler();
  frame = document.createElement("iframe");
  frame.style.width = "400px";
  frame.style.height = "300px";
  document.body.append(frame);
  const win = frame.contentWindow as EditorFrameWindow;
  Object.assign(win, {
    ReactNativeWebView: {
      postMessage: (raw: string) => {
        const event = assembler.receive(raw);
        if (event !== undefined) events.push(event as EditorEvent);
      },
    },
  });
  win.document.open();
  win.document.write(fileEditorWebViewHtml);
  win.document.close();
  let nextId = 1;
  function send(message: EditorHostMessage) {
    for (const part of encodeFrames({ message, id: nextId++ }))
      win.__PASEO_FILE_EDITOR_RECEIVE__(part);
  }
  function content() {
    return win.document.querySelector(".cm-content") as HTMLElement;
  }
  // Headless Chromium drops the contenteditable caret after the first key a test
  // types, so tests type one character; multi-edit cases edit through Find.
  async function typeAtEnd(character: string) {
    frame.focus();
    content().focus();
    await userEvent.keyboard(`{Control>}{End}{/Control}${character}`);
  }
  function eventsOf<T extends EditorEvent["type"]>(type: T) {
    return events.filter(
      (event): event is Extract<EditorEvent, { type: T }> => event.type === type,
    );
  }
  return { win, events, send, content, typeAtEnd, eventsOf };
}

async function startEditor(content = "alpha\nbeta\n") {
  const page = openEditorPage();
  await expect.poll(() => page.eventsOf("bridgeReady").length).toBe(1);
  page.send({ type: "configure", filename: "notes.ts", theme: THEME, vimEnabled: false });
  page.send({ type: "load", revision: 1, content, lineSeparator: "\n" });
  await expect.poll(() => page.eventsOf("editorReady").length).toBe(1);
  return page;
}

test("the generated editor page loads a document and reports typed edits against its revision", async () => {
  const page = await startEditor();
  expect(page.content().textContent).toContain("alpha");
  expect(page.content().getAttribute("autocapitalize")).toBe("off");
  expect(page.content().getAttribute("autocorrect")).toBe("off");
  await page.typeAtEnd("g");
  await expect
    .poll(() => page.eventsOf("edit"))
    .toEqual([{ type: "edit", revision: 1, content: "alpha\nbeta\ng" }]);
});

test("edits within the send interval wait for a flush, which posts them before acknowledging", async () => {
  const page = await startEditor("one one one\n");
  page.send({ type: "find", action: "open" });
  page.send({ type: "findQuery", query: "one" });
  page.send({ type: "findReplacement", replacement: "1" });
  page.send({ type: "find", action: "replace" });
  page.send({ type: "find", action: "replace" });
  expect(page.eventsOf("edit")).toEqual([{ type: "edit", revision: 1, content: "1 one one\n" }]);
  page.send({ type: "flush", requestId: 7, final: false });
  expect(page.events.slice(-2)).toEqual([
    { type: "edit", revision: 1, content: "1 1 one\n" },
    { type: "flushed", requestId: 7 },
  ]);
});

test("a final flush stops the page taking edits before it acknowledges", async () => {
  const page = await startEditor();
  page.send({ type: "flush", requestId: 3, final: true });
  expect(page.events.at(-1)).toEqual({ type: "flushed", requestId: 3 });
  expect(page.content().getAttribute("contenteditable")).toBe("false");
  await page.typeAtEnd("z");
  expect(page.eventsOf("edit")).toEqual([]);
  expect(page.content().textContent).toBe("alphabeta");
});

test("a replaced document is not echoed back and later edits carry the new revision", async () => {
  const page = await startEditor();
  page.send({ type: "load", revision: 2, content: "from disk\r\n", lineSeparator: "\r\n" });
  await expect.poll(() => page.content().textContent).toContain("from disk");
  expect(page.eventsOf("edit")).toEqual([]);
  await page.typeAtEnd("!");
  await expect
    .poll(() => page.eventsOf("edit").at(-1))
    .toEqual({ type: "edit", revision: 2, content: "from disk\r\n!" });
});

test("Find runs in the page and reports its state", async () => {
  const page = await startEditor("one two one\n");
  page.send({ type: "find", action: "open" });
  await expect.poll(() => page.eventsOf("find").at(-1)?.state.open).toBe(true);
  page.send({ type: "findQuery", query: "one" });
  await expect
    .poll(() => page.eventsOf("find").at(-1)?.state)
    .toMatchObject({ query: "one", total: 2, current: 1 });
  page.send({ type: "findReplacement", replacement: "1" });
  page.send({ type: "find", action: "replaceAll" });
  await expect.poll(() => page.eventsOf("edit").at(-1)?.content).toBe("1 two 1\n");
  page.send({ type: "find", action: "close" });
  await expect.poll(() => page.eventsOf("find").at(-1)?.state.open).toBe(false);
});

test("Mod-s asks the app to save after the page has posted its edits", async () => {
  const page = await startEditor();
  await page.typeAtEnd("x");
  await userEvent.keyboard("{Control>}s{/Control}");
  await expect.poll(() => page.eventsOf("save").length).toBe(1);
  const saving = page.events.filter((event) => event.type === "edit" || event.type === "save");
  expect(saving).toEqual([
    { type: "edit", revision: 1, content: "alpha\nbeta\nx" },
    { type: "save" },
  ]);
});

test("Vim mode is reported when enabled", async () => {
  const page = await startEditor();
  page.send({ type: "configure", filename: "notes.ts", theme: THEME, vimEnabled: true });
  await expect
    .poll(() => page.eventsOf("vimMode").at(-1))
    .toEqual({ type: "vimMode", mode: "NORMAL" });
  page.send({ type: "configure", filename: "notes.ts", theme: THEME, vimEnabled: false });
  await expect.poll(() => page.eventsOf("vimMode").at(-1)).toEqual({ type: "vimMode", mode: null });
});
