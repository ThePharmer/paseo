export type FileEditorPlatform = "web" | "native";

interface FileEditorPlatformPolicy {
  /** Largest file, in bytes, that opens in the editor. Larger files stay read-only. */
  sizeLimit: number;
  /** Whether an editable file opens straight into the editor or in the read-only viewer. */
  opensInEditor: boolean;
  /** Whether the file toolbar offers Edit and Done to move between the viewer and the editor. */
  hasEditToggle: boolean;
}

/**
 * Web and desktop open files in CodeMirror directly. Native hosts CodeMirror in a
 * WebView, so it opens the read-only viewer first and edits on request. Flip
 * `native.opensInEditor` to open native files in the editor like web.
 */
export const FILE_EDITOR_POLICY = {
  web: { sizeLimit: 1024 * 1024, opensInEditor: true, hasEditToggle: false },
  native: { sizeLimit: 512 * 1024, opensInEditor: false, hasEditToggle: true },
} as const satisfies Record<FileEditorPlatform, FileEditorPlatformPolicy>;

export type FileEditability = "editable" | "tooLarge" | "readOnly";

export function resolveFileEditability(input: {
  platform: FileEditorPlatform;
  supportsEditing: boolean;
  file: { kind: string; size: number } | null;
}): FileEditability {
  if (!input.supportsEditing || input.file?.kind !== "text") return "readOnly";
  if (input.file.size > FILE_EDITOR_POLICY[input.platform].sizeLimit) return "tooLarge";
  return "editable";
}
