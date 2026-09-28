export type SyncNotice = "reconnecting" | "updating";

export interface SyncNoticeSignal {
  notice: SyncNotice;
  /** Skip the show delay, for a host already known to be unreachable. */
  immediate: boolean;
}

// Most catch-ups and reconnects finish sub-second. Showing a spinner for those only
// flashes; these delays hide them while a slower recovery still announces itself.
export const UPDATING_SHOW_DELAY_MS = 400;
export const RECONNECTING_SHOW_DELAY_MS = 1_000;
// A notice that appears stays long enough to read instead of blinking at the show delay.
export const NOTICE_MIN_VISIBLE_MS = 400;

const SHOW_DELAY_MS: Record<SyncNotice, number> = {
  updating: UPDATING_SHOW_DELAY_MS,
  reconnecting: RECONNECTING_SHOW_DELAY_MS,
};

export interface SyncNoticeTimerPorts {
  now(): number;
  schedule(task: () => void, delayMs: number): () => void;
}

export interface DelayedSyncNotice {
  /** Reports the real status for `key`, the pane's chat. A new key drops the shown notice. */
  update(key: string, signal: SyncNoticeSignal | null): void;
  /** Cancels the pending timer. A later `update` resumes from the real status. */
  dispose(): void;
}

/**
 * Turns the real sync status into the notice the chat shows. The show delay counts from
 * when the chat stopped being current, not from the latest label, so a reconnect followed
 * by a catch-up cannot hide behind two fresh delays.
 */
export function createDelayedSyncNotice(input: {
  ports: SyncNoticeTimerPorts;
  onChange: (notice: SyncNotice | null) => void;
}): DelayedSyncNotice {
  const { ports, onChange } = input;
  let key: string | null = null;
  let latest: SyncNoticeSignal | null = null;
  let shown: SyncNotice | null = null;
  let shownAt = 0;
  let staleSince: number | null = null;
  let cancelTimer: (() => void) | null = null;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const wait = (delayMs: number) => {
    cancelTimer = ports.schedule(() => {
      cancelTimer = null;
      evaluate();
    }, delayMs);
  };

  const show = (notice: SyncNotice) => {
    shown = notice;
    shownAt = ports.now();
    onChange(notice);
  };

  const hide = () => {
    shown = null;
    staleSince = null;
    onChange(null);
  };

  function evaluate(): void {
    clearTimer();
    const now = ports.now();
    if (shown !== null) {
      if (latest !== null) {
        if (latest.notice !== shown) show(latest.notice);
        return;
      }
      const remainingMs = shownAt + NOTICE_MIN_VISIBLE_MS - now;
      if (remainingMs > 0) wait(remainingMs);
      else hide();
      return;
    }
    if (latest === null) {
      staleSince = null;
      return;
    }
    staleSince ??= now;
    const delayMs = latest.immediate ? 0 : SHOW_DELAY_MS[latest.notice];
    const remainingMs = staleSince + delayMs - now;
    if (remainingMs > 0) wait(remainingMs);
    else show(latest.notice);
  }

  return {
    update(nextKey, signal) {
      if (nextKey !== key) {
        key = nextKey;
        clearTimer();
        staleSince = null;
        if (shown !== null) hide();
      }
      latest = signal;
      evaluate();
    },
    dispose: clearTimer,
  };
}
