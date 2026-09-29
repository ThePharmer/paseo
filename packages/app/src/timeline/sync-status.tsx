import type { Theme } from "@/styles/theme";
import { useEffect, useMemo, useState } from "react";
import type { AgentScreenReadySyncState } from "@/hooks/use-agent-screen-state-machine";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { ToastViewport, type ToastState } from "@/components/toast-host";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useAppVisible } from "@/hooks/use-app-visible";
import {
  createDelayedSyncNotice,
  monotonicNoticeTimers,
  type SyncNotice,
  type SyncNoticeSignal,
} from "@/timeline/sync-status-timing";

const spinnerColor = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const keepUntilSynchronized = () => {};

function toSyncNoticeSignal(sync: AgentScreenReadySyncState | null): SyncNoticeSignal | null {
  if (sync?.status === "reconnecting") {
    return { notice: "reconnecting", timing: sync.hasFailedAttempt ? "immediate" : "delayed" };
  }
  if (sync?.status === "verifying") {
    return { notice: "updating", timing: "quiet" };
  }
  if (sync?.status === "catching_up" && sync.ui === "status") {
    return { notice: "updating", timing: "delayed" };
  }
  return null;
}

function useDelayedSyncNotice(key: string, signal: SyncNoticeSignal | null): SyncNotice | null {
  const [shown, setShown] = useState<SyncNotice | null>(null);
  const [delayedNotice] = useState(() =>
    createDelayedSyncNotice({ ports: monotonicNoticeTimers, onChange: setShown }),
  );
  const isAppVisible = useAppVisible();
  const notice = signal?.notice ?? null;
  const timing = signal?.timing ?? "delayed";
  useEffect(() => {
    delayedNotice.setVisible(isAppVisible);
  }, [delayedNotice, isAppVisible]);
  useEffect(() => {
    delayedNotice.update(key, notice ? { notice, timing } : null);
  }, [delayedNotice, key, notice, timing]);
  useEffect(() => () => delayedNotice.dispose(), [delayedNotice]);
  return shown;
}

export function TimelineSyncStatus({
  statusKey,
  sync,
  toast,
  onDismiss,
}: {
  /** Identifies the chat shown in this pane, so a switch never inherits its notice timing. */
  statusKey: string;
  sync: AgentScreenReadySyncState | null;
  toast: ToastState | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const state = useDelayedSyncNotice(statusKey, toSyncNoticeSignal(sync));
  const label = state ? t(`agentPanel.states.${state}`) : null;
  const syncToast = useMemo<ToastState | null>(
    () =>
      state && label
        ? {
            id: state === "reconnecting" ? 1 : 2,
            content: label,
            nativeMessage: label,
            icon: <ThemedLoadingSpinner size={18} uniProps={spinnerColor} />,
            variant: "default",
            durationMs: null,
            testID: `agent-${state}-toast`,
          }
        : null,
    [state, label],
  );
  return (
    <ToastViewport
      toast={toast ?? syncToast}
      onDismiss={toast ? onDismiss : keepUntilSynchronized}
      placement="panel"
    />
  );
}
