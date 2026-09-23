import type { FileEditorModel } from "./model";
import { FILE_EDITOR_POLICY, fitsEditor, type FileEditorPlatform } from "./policy";
import type { FileEditorViewHandle } from "./view-contract";

export type EditorPresence = "viewing" | "editing" | "finishing";

export interface FileEditingSnapshot {
  presence: EditorPresence;
  /** The mounted editor view can take commands such as Find. */
  editorReady: boolean;
}

/**
 * Owns one open file's editing lifecycle around its `FileEditorModel`: moving
 * between the read-only viewer and the editor, and getting edits out of the editor
 * view before it goes away. The native editor holds its newest keystrokes in a
 * WebView until it is asked to flush, so every exit path flushes before it
 * unmounts the view or saves.
 */
export class FileEditingSession {
  private readonly model: FileEditorModel;
  private readonly platform: FileEditorPlatform;
  private readonly listeners = new Set<() => void>();
  private surface: FileEditorViewHandle | null = null;
  private closed = false;
  private snapshot: FileEditingSnapshot;

  constructor(input: { model: FileEditorModel; platform: FileEditorPlatform }) {
    this.model = input.model;
    this.platform = input.platform;
    const presence = FILE_EDITOR_POLICY[input.platform].opensInEditor ? "editing" : "viewing";
    this.snapshot = { presence, editorReady: false };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FileEditingSnapshot => this.snapshot;

  /** Pass as the editor view's ref. */
  attachSurface = (surface: FileEditorViewHandle | null): void => {
    this.surface = surface;
    if (!surface) this.setEditorReady(false);
  };

  setEditorReady = (editorReady: boolean): void => {
    if (this.snapshot.editorReady === editorReady) return;
    this.update({ editorReady });
  };

  /** The size limit applies when editing starts; a file that grows while open stays editable. */
  canStart(size: number): boolean {
    return fitsEditor(this.platform, size);
  }

  start = (size: number): void => {
    if (this.closed || this.snapshot.presence !== "viewing" || !this.canStart(size)) return;
    this.update({ presence: "editing" });
  };

  /** Done: the view stays mounted until it has handed over its last edits. */
  finish = async (): Promise<void> => {
    if (this.closed || this.snapshot.presence !== "editing") return;
    this.update({ presence: "finishing" });
    await this.surface?.finish();
    if (this.closed) return;
    this.update({ presence: "viewing" });
  };

  openFind = (): void => {
    this.surface?.openFind();
  };

  /** The OS can suspend or kill a backgrounded app before autosave fires. */
  async background(): Promise<void> {
    await this.surface?.flush();
    if (this.closed) return;
    await this.model.save();
  }

  /**
   * The view is already gone when this runs, so edits it never posted are lost;
   * everything the model holds is saved unless a close-without-saving confirmation
   * suspended autosave.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.surface = null;
    this.model.close();
    this.listeners.clear();
  }

  private update(patch: Partial<FileEditingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
