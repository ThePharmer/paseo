export type FileEditorPlatform = "web" | "native";

interface FileEditorPlatformPolicy {
  /** Largest file, in bytes, that opens in the editor. Larger files stay read-only. */
  sizeLimit: number;
  /** Whether an editable file opens straight into the editor or in the read-only viewer. */
  opensInEditor: boolean;
  /** Whether the file toolbar offers Edit and Done to move between the viewer and the editor. */
  hasEditToggle: boolean;
  /** Whether leaving the foreground saves unsaved edits instead of waiting for autosave. */
  savesOnBackground: boolean;
}

/**
 * Web and desktop open files in CodeMirror directly. Native hosts CodeMirror in a
 * WebView, so it opens the read-only viewer first and edits on request. Flip
 * `native.opensInEditor` to open native files in the editor like web.
 */
export const FILE_EDITOR_POLICY = {
  web: {
    sizeLimit: 1024 * 1024,
    opensInEditor: true,
    hasEditToggle: false,
    savesOnBackground: false,
  },
  native: {
    sizeLimit: 512 * 1024,
    opensInEditor: false,
    hasEditToggle: true,
    savesOnBackground: true,
  },
} as const satisfies Record<FileEditorPlatform, FileEditorPlatformPolicy>;

export type FileEditability = "editable" | "tooLarge" | "readOnly";

/**
 * The size limit applies when an editor opens. `sessionOpen` means this file already
 * has one, so growing past the limit (often through its own autosave) keeps it
 * editable instead of tearing down the editor and its unsaved edits.
 */
export function resolveFileEditability(input: {
  platform: FileEditorPlatform;
  supportsEditing: boolean;
  file: { kind: string; size: number } | null;
  sessionOpen: boolean;
}): FileEditability {
  if (!input.supportsEditing || input.file?.kind !== "text") return "readOnly";
  if (input.sessionOpen) return "editable";
  return fitsEditor(input.platform, input.file.size) ? "editable" : "tooLarge";
}

export function fitsEditor(platform: FileEditorPlatform, size: number): boolean {
  return size <= FILE_EDITOR_POLICY[platform].sizeLimit;
}

export interface EditorFile {
  /** Identifies the file itself, not the pane's target, so a latch never crosses files. */
  path: string;
  kind: string;
  size: number;
}

export interface TrackedEditability {
  editability: FileEditability;
  /** The file whose editor is open after this decision, or null. */
  openEditorPath: string | null;
}

/**
 * Applies `resolveFileEditability` across renders: the file that already has an
 * editor open keeps it while it grows, and any other file faces the size limit.
 * A disconnected host shows no editor, which ends the session.
 */
export function trackFileEditability(input: {
  platform: FileEditorPlatform;
  supportsEditing: boolean;
  connected: boolean;
  file: EditorFile | null;
  openEditorPath: string | null;
}): TrackedEditability {
  const path = input.connected && input.file ? input.file.path : null;
  const editability = resolveFileEditability({
    platform: input.platform,
    supportsEditing: input.supportsEditing,
    file: input.file,
    sessionOpen: path !== null && path === input.openEditorPath,
  });
  return { editability, openEditorPath: editability === "editable" ? path : null };
}
