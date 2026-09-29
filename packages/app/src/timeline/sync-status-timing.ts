export type SyncNotice = "reconnecting" | "updating";

export interface SyncNoticeSignal {
  notice: SyncNotice;
  /**
   * `delayed` shows after the notice's show delay. `immediate` skips it, for a host already
   * known to be unreachable. `quiet` is a catch-up presumed to change nothing: it never
   * shows on its own, but a notice already on screen stays up, relabeled, until it settles.
   */
  timing: "delayed" | "immediate" | "quiet";
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
  /** A monotonic clock. Only the show delay reads it; the minimum visible time is a timer. */
  now(): number;
  schedule(task: () => void, delayMs: number): () => void;
}

// performance.now() is monotonic on Hermes and web. Date.now() follows wall-clock changes, so
// setting the clock back would delay a pending notice or pin a shown one by the same amount.
export const monotonicNoticeTimers: SyncNoticeTimerPorts = {
  now: () => performance.now(),
  schedule: (task, delayMs) => {
    const timeout = setTimeout(task, delayMs);
    return () => clearTimeout(timeout);
  },
};

export interface DelayedSyncNotice {
  /** Reports the real status for `key`, the pane's chat. A new key drops the shown notice. */
  update(key: string, signal: SyncNoticeSignal | null): void;
  /**
   * Nothing new shows while the app is hidden. Returning restarts the show delay, so a notice
   * that fell due in the background waits for the user to watch the chat stay behind.
   */
  setVisible(visible: boolean): void;
  /** Cancels the pending timers. A later `update` resumes from the real status. */
  dispose(): void;
}

/**
 * Turns the real sync status into the notice the chat shows. The show delay counts from
 * when the chat stopped being current, not from the latest label, so a reconnect followed
 * by a catch-up cannot hide behind two fresh delays. An immediate signal and the minimum
 * visible time never read the clock, and a scheduled show is never recomputed, so a clock
 * change cannot hold back a known outage or keep a notice up after the chat recovers.
 * Hidden time does not count: the delay exists to hide blips the user would see, and a
 * mobile OS can hold the app long enough for any delay to run out unseen.
 */
export function createDelayedSyncNotice(input: {
  ports: SyncNoticeTimerPorts;
  onChange: (notice: SyncNotice | null) => void;
}): DelayedSyncNotice {
  const { ports, onChange } = input;
  let key: string | null = null;
  let visible = true;
  let latest: SyncNoticeSignal | null = null;
  let shown: SyncNotice | null = null;
  let staleSince: number | null = null;
  let pendingShow: { notice: SyncNotice; cancel: () => void } | null = null;
  let cancelMinVisible: (() => void) | null = null;

  const cancelPendingShow = () => {
    pendingShow?.cancel();
    pendingShow = null;
  };

  const endMinVisible = () => {
    cancelMinVisible?.();
    cancelMinVisible = null;
  };

  const show = (notice: SyncNotice) => {
    cancelPendingShow();
    endMinVisible();
    shown = notice;
    cancelMinVisible = ports.schedule(() => {
      cancelMinVisible = null;
      evaluate();
    }, NOTICE_MIN_VISIBLE_MS);
    onChange(notice);
  };

  const hide = () => {
    endMinVisible();
    shown = null;
    staleSince = null;
    onChange(null);
  };

  function evaluate(): void {
    if (shown !== null) {
      if (latest === null) {
        if (cancelMinVisible === null) hide();
      } else if (latest.notice !== shown) {
        show(latest.notice);
      }
      return;
    }
    if (latest === null || latest.timing === "quiet") {
      cancelPendingShow();
      staleSince = null;
      return;
    }
    if (!visible) {
      cancelPendingShow();
      return;
    }
    if (latest.timing === "immediate") {
      show(latest.notice);
      return;
    }
    if (pendingShow?.notice === latest.notice) return;
    cancelPendingShow();
    const now = ports.now();
    staleSince ??= now;
    const delayMs = SHOW_DELAY_MS[latest.notice];
    const remainingMs = Math.min(delayMs, staleSince + delayMs - now);
    if (remainingMs <= 0) {
      show(latest.notice);
      return;
    }
    const notice = latest.notice;
    pendingShow = {
      notice,
      cancel: ports.schedule(() => {
        pendingShow = null;
        show(notice);
      }, remainingMs),
    };
  }

  return {
    update(nextKey, signal) {
      if (nextKey !== key) {
        key = nextKey;
        cancelPendingShow();
        staleSince = null;
        if (shown !== null) hide();
      }
      latest = signal;
      evaluate();
    },
    setVisible(nextVisible) {
      if (nextVisible === visible) return;
      visible = nextVisible;
      if (visible) staleSince = null;
      evaluate();
    },
    dispose() {
      cancelPendingShow();
      endMinVisible();
    },
  };
}
