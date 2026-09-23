import type { Ref } from "react";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "./extensions.web";
import type { FileEditorModel } from "./model";

export interface FileEditorViewHandle {
  /** Resolves once every edit the view holds has reached the model. */
  flush(): Promise<void>;
  openFind(): void;
}

/** Shared by the CodeMirror view on web and the WebView-hosted view on native. */
export interface FileEditorViewProps {
  ref?: Ref<FileEditorViewHandle>;
  model: FileEditorModel;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  vimEnabled: boolean;
  theme: EditorVisualTheme;
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
}
