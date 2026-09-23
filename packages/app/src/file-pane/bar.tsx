import { Text, View } from "react-native";
import { Search } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  PaneContentToolbar,
  ToolbarButton,
  paneContentToolbarIconSize,
} from "@/components/ui/pane-content-toolbar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { FileConflictAlert, type FileConflictAlertState } from "./conflict-alert";
import type { FileEditorStatus } from "./editor/model";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const SearchIcon = withUnistyles(Search, mutedIconColorMapping);

/** The Edit/Done toggle for platforms that open files read-only first. */
export type FilePanelEditing =
  | { kind: "viewing"; onEdit(): void }
  | { kind: "tooLarge" }
  | { kind: "editing"; finishing: boolean; onFind(): void; onDone(): void };

export function FilePanelBar({
  size,
  lineCount,
  mode,
  onModeChange,
  editorStatus,
  cursor,
  vimMode,
  conflict,
  editing,
}: {
  size: number;
  lineCount?: number;
  mode?: "preview" | "source";
  onModeChange?(mode: "preview" | "source"): void;
  editorStatus?: FileEditorStatus;
  cursor?: { line: number; column: number };
  vimMode?: string | null;
  conflict?: FileConflictAlertState;
  editing?: FilePanelEditing;
}) {
  const { t } = useTranslation();
  const previewModes = [
    {
      value: "preview" as const,
      label: t("panels.file.editor.preview"),
      testID: "file-mode-preview",
    },
    { value: "source" as const, label: t("panels.file.editor.source"), testID: "file-mode-source" },
  ];
  return (
    <View style={styles.chrome}>
      <PaneContentToolbar testID="file-panel-bar">
        <View style={styles.row}>
          <View style={styles.metadata}>
            <Text
              style={styles.whisper}
              accessibilityLabel={t("panels.file.editor.fileSize", { size: formatFileSize(size) })}
            >
              {formatFileSize(size)}
            </Text>
            {lineCount !== undefined ? (
              <Text
                style={styles.whisper}
                accessibilityLabel={t("panels.file.editor.lines", { count: lineCount })}
              >
                {t("panels.file.editor.lines", { count: lineCount })}
              </Text>
            ) : null}
          </View>
          <View
            style={styles.status}
            accessibilityLabel={
              editorStatus
                ? t("panels.file.editor.editorStatus", { status: editorStatus })
                : undefined
            }
          >
            {editorStatus === "dirty" ? (
              <View
                style={styles.dirtyDot}
                accessibilityLabel={t("panels.file.editor.unsavedChanges")}
              />
            ) : null}
            {editorStatus === "saving" ? (
              <>
                <ThemedSpinner size={14} uniProps={spinnerMapping} />
                <Text style={styles.secondary}>{t("panels.file.editor.saving")}</Text>
              </>
            ) : null}
            {editorStatus === "error" ? (
              <Text style={styles.error}>{t("panels.file.editor.saveFailed")}</Text>
            ) : null}
            {vimMode ? (
              <Text
                style={styles.vim}
                accessibilityLabel={t("panels.file.editor.vimMode", { mode: vimMode })}
              >
                {vimMode}
              </Text>
            ) : null}
            {cursor ? (
              <Text
                style={styles.whisper}
                accessibilityLabel={t("panels.file.editor.cursor", cursor)}
              >
                Ln {cursor.line}, Col {cursor.column}
              </Text>
            ) : null}
          </View>
          {mode && onModeChange ? (
            <SegmentedControl
              size="xs"
              value={mode}
              onValueChange={onModeChange}
              testID="file-preview-mode"
              options={previewModes}
            />
          ) : null}
          {editing ? <FilePanelEditingControls editing={editing} /> : null}
        </View>
      </PaneContentToolbar>
      {conflict ? <FileConflictAlert state={conflict} /> : null}
    </View>
  );
}

function FilePanelEditingControls({ editing }: { editing: FilePanelEditing }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  if (editing.kind === "tooLarge") {
    return <Text style={styles.whisper}>{t("panels.file.editor.tooLargeToEdit")}</Text>;
  }
  if (editing.kind === "viewing") {
    return (
      <Button variant="ghost" size="xs" onPress={editing.onEdit} testID="file-edit">
        {t("panels.file.editor.edit")}
      </Button>
    );
  }
  return (
    <View style={styles.status}>
      <ToolbarButton label={t("paneFind.title")} compact={isCompact} onPress={editing.onFind}>
        <SearchIcon size={paneContentToolbarIconSize(isCompact)} />
      </ToolbarButton>
      <Button
        variant="ghost"
        size="xs"
        onPress={editing.onDone}
        loading={editing.finishing}
        testID="file-edit-done"
      >
        {t("panels.file.editor.done")}
      </Button>
    </View>
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create((theme) => ({
  chrome: {
    flexShrink: 0,
  },
  row: {
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  metadata: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  whisper: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  status: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  vim: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
