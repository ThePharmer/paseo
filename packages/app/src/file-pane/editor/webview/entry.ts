import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type StateEffect,
} from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { getLanguageForFile } from "@getpaseo/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import { isFindShortcut } from "@/pane-find/find-shortcut";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { isMacUserAgent } from "@/utils/mac-user-agent";
import { FileFindModel } from "../../find/model.web";
import { editorBaseExtensions, editorTheme, type EditorVisualTheme } from "../extensions.web";
import { systemClock, type FileLineSeparator } from "../model";
import { encodeFrames, FrameAssembler } from "./frames";
import { EditOutbox } from "./outbox";
import type { EditorEvent, EditorHostMessage } from "./protocol";

// EditContext makes Gboard corrections move the caret and duplicate text in
// Android WebViews. CodeMirror reads this undeclared static when it builds a view.
Object.assign(EditorView, { EDIT_CONTEXT: false });

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage?: (data: string) => void;
    };
    __PASEO_FILE_EDITOR_RECEIVE__?: (frame: string) => void;
  }
}

type Configuration = Extract<EditorHostMessage, { type: "configure" }>;

const CARET_MARGIN_PX = 32;
const remoteUpdate = Annotation.define<boolean>();
const languageCompartment = new Compartment();
const themeCompartment = new Compartment();
const vimCompartment = new Compartment();
const editableCompartment = new Compartment();

let nextFrameId = 1;
function post(event: EditorEvent): void {
  for (const frame of encodeFrames({ message: event, id: nextFrameId++ })) {
    window.ReactNativeWebView?.postMessage?.(frame);
  }
}

function installStyles(): void {
  const style = document.createElement("style");
  style.textContent = `
html, body, #editor {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  overscroll-behavior: none;
  -webkit-text-size-adjust: 100%;
}
#editor { position: relative; }
#find-clearance {
  position: fixed;
  top: 0;
  right: 0;
  pointer-events: none;
  visibility: hidden;
}
`;
  document.head.appendChild(style);
}

installStyles();
const host = document.createElement("div");
host.id = "editor";
document.body.appendChild(host);
// Stands in for the app's Find widget, which floats over this page, so the
// shared Find model can keep matches clear of it and pick a corner.
const findClearance = document.createElement("div");
findClearance.id = "find-clearance";
document.body.appendChild(findClearance);

const find = new FileFindModel();
let view: EditorView | null = null;
let configuration: Configuration | null = null;
let revision = 0;
let lineSeparator: FileLineSeparator = "\n";
let cursor = { line: 0, column: 0 };
let detachVimModeListener: (() => void) | null = null;

const outbox = new EditOutbox({
  clock: systemClock,
  send: () => {
    if (!view) return;
    post({
      type: "edit",
      revision,
      content: view.state.doc.sliceString(0, undefined, lineSeparator),
    });
  },
});

function themeFor(theme: EditorVisualTheme) {
  // Native font names such as ui-monospace are not CSS families on every engine.
  return editorTheme({ ...theme, monoFont: `${theme.monoFont}, monospace` });
}

function languageFor(filename: string) {
  return getLanguageForFile(filename)?.extension ?? [];
}

function save(): void {
  outbox.flush();
  post({ type: "save" });
}

function reportCursor(state: EditorState): void {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const next = { line: line.number, column: head - line.from + 1 };
  if (next.line === cursor.line && next.column === cursor.column) return;
  cursor = next;
  post({ type: "cursor", ...next });
}

function handleUpdate(update: ViewUpdate): void {
  if (update.docChanged && !update.transactions.some((tr) => tr.annotation(remoteUpdate))) {
    outbox.change();
  }
  if (update.selectionSet || update.docChanged) reportCursor(update.state);
  if (update.focusChanged && !update.view.hasFocus) outbox.flush();
}

function followVimMode(editor: EditorView, enabled: boolean): void {
  detachVimModeListener?.();
  detachVimModeListener = null;
  if (!enabled) {
    post({ type: "vimMode", mode: null });
    return;
  }
  const cm = getCM(editor);
  if (!cm) return;
  function handleModeChange(event: { mode?: string }) {
    post({ type: "vimMode", mode: (event.mode ?? "normal").toUpperCase() });
  }
  cm.on("vim-mode-change", handleModeChange);
  detachVimModeListener = () => cm.off("vim-mode-change", handleModeChange);
  post({ type: "vimMode", mode: "NORMAL" });
}

function createEditor(content: string, config: Configuration): EditorView {
  const editor = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: content,
      extensions: [
        vimCompartment.of(config.vimEnabled ? vim() : []),
        editableCompartment.of(EditorView.editable.of(true)),
        find.extension,
        ...editorBaseExtensions(save),
        languageCompartment.of(languageFor(config.filename)),
        // Phone-width panes wrap every file, matching the native read-only viewer.
        EditorView.lineWrapping,
        themeCompartment.of(themeFor(config.theme)),
        EditorView.contentAttributes.of({
          autocorrect: "off",
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: "false",
        }),
        EditorView.updateListener.of(handleUpdate),
      ],
    }),
  });
  followVimMode(editor, config.vimEnabled);
  reportCursor(editor.state);
  return editor;
}

function configure(next: Configuration): void {
  const previous = configuration;
  configuration = next;
  document.body.style.background = next.theme.background;
  if (!view || !previous) return;
  const effects: StateEffect<unknown>[] = [];
  if (previous.filename !== next.filename) {
    effects.push(languageCompartment.reconfigure(languageFor(next.filename)));
  }
  if (previous.theme !== next.theme)
    effects.push(themeCompartment.reconfigure(themeFor(next.theme)));
  if (previous.vimEnabled !== next.vimEnabled) {
    effects.push(vimCompartment.reconfigure(next.vimEnabled ? vim() : []));
  }
  if (effects.length > 0) view.dispatch({ effects });
  if (previous.vimEnabled !== next.vimEnabled) followVimMode(view, next.vimEnabled);
}

function load(message: Extract<EditorHostMessage, { type: "load" }>): void {
  outbox.discard();
  revision = message.revision;
  lineSeparator = message.lineSeparator;
  if (!view) {
    if (!configuration) throw new Error("The editor must be configured before a document loads");
    view = createEditor(message.content, configuration);
    post({ type: "editorReady" });
    return;
  }
  const next = view.state.toText(message.content);
  if (view.state.doc.eq(next)) return;
  const head = Math.min(view.state.selection.main.head, next.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    selection: { anchor: head },
    annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)],
  });
}

/** The app is about to unmount this page; keystrokes after the last flush would be lost. */
function stopEditing(): void {
  if (!view) return;
  view.contentDOM.blur();
  view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(false)) });
}

function reveal(editor: EditorView, range: { lineStart: number; lineEnd: number }): void {
  const lineStart = Math.min(range.lineStart, editor.state.doc.lines);
  const lineEnd = Math.min(range.lineEnd, editor.state.doc.lines);
  const from = editor.state.doc.line(lineStart).from;
  const to = editor.state.doc.line(Math.max(lineStart, lineEnd)).to;
  editor.dispatch({
    selection: { anchor: from, head: lineEnd > lineStart ? to : from },
    effects: EditorView.scrollIntoView(from, { y: "center" }),
  });
}

function runFind(editor: EditorView, message: Extract<EditorHostMessage, { type: "find" }>): void {
  switch (message.action) {
    case "open":
      find.open(editor);
      return;
    case "close":
      find.close();
      return;
    case "next":
      find.next();
      return;
    case "previous":
      find.previous();
      return;
    case "replace":
      find.replace();
      return;
    case "replaceAll":
      find.replaceAll();
      return;
  }
}

function placeFindClearance(size: { width: number; height: number }): void {
  findClearance.style.width = `${size.width}px`;
  findClearance.style.height = `${size.height}px`;
  find.setWidgetNode(findClearance);
}

function handle(message: EditorHostMessage): void {
  if (message.type === "configure") return configure(message);
  if (message.type === "load") return load(message);
  if (message.type === "flush") {
    if (message.final) stopEditing();
    outbox.flush();
    post({ type: "flushed", requestId: message.requestId });
    return;
  }
  if (!view) return;
  switch (message.type) {
    case "reveal":
      reveal(view, message);
      return;
    case "find":
      runFind(view, message);
      return;
    case "findQuery":
      find.setSearch(message.query);
      return;
    case "findReplacement":
      find.setReplacement(message.replacement);
      return;
    case "findWidget":
      placeFindClearance(message);
      return;
  }
}

find.subscribe(() => {
  const state = find.getSnapshot();
  findClearance.style.top = state.placement === "top" ? "0px" : "auto";
  findClearance.style.bottom = state.placement === "bottom" ? "0px" : "auto";
  post({ type: "find", state });
});

// When the keyboard opens, the app shrinks this WebView; keep the caret above it.
window.addEventListener("resize", () => {
  if (!view?.hasFocus) return;
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.selection.main.head, {
      y: "nearest",
      yMargin: CARET_MARGIN_PX,
    }),
  });
});

document.addEventListener("keydown", (event) => {
  if (!view || event.defaultPrevented || isImeComposingKeyboardEvent(event)) return;
  if (!isFindShortcut(event, { isMac: isMacUserAgent() })) return;
  event.preventDefault();
  find.open(view);
});

const assembler = new FrameAssembler();
window.__PASEO_FILE_EDITOR_RECEIVE__ = (frame) => {
  const message = assembler.receive(frame);
  // Host messages come from the app's own injectJavaScript call; see EditorHostMessage.
  if (message !== undefined) handle(message as EditorHostMessage);
};

post({ type: "bridgeReady" });
