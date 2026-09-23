import { z } from "zod";
import type { EditorVisualTheme } from "../extensions.web";
import type { FileLineSeparator } from "../model";

export type EditorFindAction = "open" | "close" | "next" | "previous" | "replace" | "replaceAll";

/**
 * App to WebView. These arrive through `injectJavaScript`, which already runs
 * arbitrary app code in the page, so the page trusts them as typed.
 *
 * `load` replaces the whole document and starts a new revision. The page tags
 * every `edit` with the revision it was typed against, which lets the app drop
 * edits that raced a replacement.
 */
export type EditorHostMessage =
  | { type: "configure"; filename: string; theme: EditorVisualTheme; vimEnabled: boolean }
  | { type: "load"; revision: number; content: string; lineSeparator: FileLineSeparator }
  | { type: "reveal"; lineStart: number; lineEnd: number }
  | { type: "flush"; requestId: number; final: boolean }
  | { type: "find"; action: EditorFindAction }
  | { type: "findQuery"; query: string }
  | { type: "findReplacement"; replacement: string }
  | { type: "findWidget"; width: number; height: number };

const findStateSchema = z.object({
  open: z.boolean(),
  placement: z.enum(["top", "bottom"]),
  query: z.string(),
  replacement: z.string(),
  current: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  limited: z.boolean(),
  readOnly: z.boolean(),
});

export type EditorFindState = z.infer<typeof findStateSchema>;

const editorEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bridgeReady") }),
  z.object({ type: z.literal("editorReady") }),
  z.object({ type: z.literal("edit"), revision: z.number().int(), content: z.string() }),
  z.object({ type: z.literal("flushed"), requestId: z.number().int() }),
  z.object({ type: z.literal("save") }),
  z.object({
    type: z.literal("cursor"),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  }),
  z.object({ type: z.literal("vimMode"), mode: z.string().nullable() }),
  z.object({ type: z.literal("find"), state: findStateSchema }),
]);

/** WebView to app. The app validates these like any other inbound IPC. */
export type EditorEvent = z.infer<typeof editorEventSchema>;

export function parseEditorEvent(value: unknown): EditorEvent | null {
  const result = editorEventSchema.safeParse(value);
  return result.success ? result.data : null;
}
