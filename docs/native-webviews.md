# Native WebViews

iOS and Android run three pieces of web code inside `react-native-webview`: the terminal (xterm.js), Mermaid diagrams, and the file editor (CodeMirror 6). Each one is an esbuild IIFE inlined into a single HTML string that ships inside the app. The page loads nothing over the network and Metro never sees its source.

## Bundles

| Bundle      | Entry                                                                  | Generated file                                                           | Rebuild                                                       |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Terminal    | `packages/app/src/terminal/webview/terminal-emulator-webview-entry.ts` | `packages/app/src/terminal/webview/terminal-emulator-webview-html.ts`    | `npm run build:terminal-webview --workspace=@getpaseo/app`    |
| Mermaid     | `packages/app/src/components/markdown/fence/mermaid/runtime/entry.ts`  | `packages/app/src/components/markdown/fence/mermaid/runtime/html.gen.ts` | `npm run build:mermaid-runtime --workspace=@getpaseo/app`     |
| File editor | `packages/app/src/file-pane/editor/webview/entry.ts`                   | `packages/app/src/file-pane/editor/webview/html.gen.ts`                  | `npm run build:file-editor-webview --workspace=@getpaseo/app` |

- Commit the generated file. Rebuild it whenever the entry or anything it imports changes. For the file editor that includes `extensions.web.ts`, the Find model in `file-pane/find/model.web.ts`, and `@getpaseo/highlight`. `npm run check:file-editor-webview --workspace=@getpaseo/app` rebuilds the editor bundle in memory and fails if the committed file differs. Nothing runs it automatically, and the terminal and Mermaid bundles have no check, so a stale bundle ships silently.
- EAS builds regenerate the terminal and file editor bundles in `eas-build-post-install`. Local, F-Droid, and every other build use the committed files.
- Bundles resolve workspace packages through their `dist`. Run `npm run build:app-deps` before rebuilding a bundle that imports one.
- Entries cannot import React Native or anything that does. Pass platform facts in as parameters; `isFindShortcut` takes the platform for this reason.
- Name new generated files `*.gen.ts` so the formatter skips them.

## File editor

Web and desktop run CodeMirror directly in `packages/app/src/file-pane/editor/view.web.tsx`. Native hosts the same extensions and Find model in a WebView through `view.native.tsx` and `webview/host.ts`, and both feed the same `FileEditorModel`. Native opens files in the read-only viewer and switches to the editor on Edit; `FILE_EDITOR_POLICY` in `editor/policy.ts` owns that choice and the per-platform size cap. `FileEditingSession` in `editor/session.ts` owns Edit, Done, backgrounding, and close.

The size cap applies when an editor opens: on web when the file opens, on native when you tap Edit. A file that grows past the cap while its editor is open, often through its own autosave, stays editable. Re-checking the cap on every render tore the editor down mid-edit and dropped the unsaved buffer.

Rules for the bridge:

- **The page owns the document while you edit.** Do not push the document into the page on render, and do not send edits back to the page as props. That round trip races the next keystroke and resets the caret. The page posts its document through `EditOutbox`: the first change goes out at once, so the model turns dirty on the first keystroke and a concurrent disk change becomes a conflict instead of a reload. Later changes go out at most every 300 ms.
- **Only an outside change enters the page.** The host pushes a document when the model's content changes for any reason other than a page edit, such as Reload or a clean file changing on disk. Each push starts a new revision. The page tags every edit with the revision it was typed against, and the host drops edits for an older revision.
- **Flush before the WebView goes away.** Unposted edits die with the page. Done calls `finish()` on the editor handle and keeps the view mounted until it answers; the page stops taking edits before it replies, so nothing typed in between is lost. This is also why the Preview/Source toggle is hidden while native is editing. The page flushes on save and blur, and the session flushes and saves when the app leaves the foreground, because the OS can suspend or kill the app before autosave fires.
- **Closing saves.** Any other unmount cannot reach the page any more, so the session saves whatever the model holds. Every close confirmation that promises to discard drafts, single-tab and bulk, holds the panels' saves with `holdModifiedPanelSaves` or `suspendPendingSave`; a model whose autosave is held discards on close and refuses `save()`. Keep new discard wording paired with a hold.
- **Messages are framed.** Documents can reach hundreds of KiB, so both directions cut every message into 64 KiB frames (`webview/frames.ts`). A cut never splits a surrogate pair, which a UTF-8 transcoding bridge would turn into two replacement characters.
- **EditContext stays off.** Keep the `EDIT_CONTEXT` line at the top of `webview/entry.ts`; its comment says why.
- **The page may never start.** Some devices fail to load or parse a multi-megabyte inline script. The view shows a spinner until the page reports `editorReady`. If that takes longer than `EDITOR_READY_TIMEOUT_MS`, the view falls back to the read-only viewer with an error and Retry. A crashed WebView process restarts the editor from the model's content.
- **The keyboard shrinks the WebView.** On every native form factor, tablets included, the view pads by the keyboard height while it is up, and the page scrolls the caret into view when its viewport resizes. The WebView's own scrolling is off; CodeMirror scrolls inside the page.

`webview/html.browser.test.ts` drives the generated editor page in headless Chromium, so rebuild the bundle before you run it. It cannot exercise Android's input stack or the keyboard; check those on a device.
