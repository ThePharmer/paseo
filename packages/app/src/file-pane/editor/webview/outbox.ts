import type { FileEditorClock } from "../model";

export const EDIT_SEND_INTERVAL_MS = 300;

/**
 * Paces how often the WebView editor posts its document to the app. The first
 * change after a quiet period goes out at once, so the app marks the file dirty
 * on the first keystroke and treats a concurrent disk change as a conflict. Later
 * changes go out at most once per interval, and `flush` sends anything pending
 * immediately.
 */
export class EditOutbox {
  private readonly clock: FileEditorClock;
  private readonly intervalMs: number;
  private readonly send: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;

  constructor(input: { clock: FileEditorClock; send(): void; intervalMs?: number }) {
    this.clock = input.clock;
    this.send = input.send;
    this.intervalMs = input.intervalMs ?? EDIT_SEND_INTERVAL_MS;
  }

  change(): void {
    if (this.timer) {
      this.pending = true;
      return;
    }
    this.sendNow();
  }

  flush(): void {
    if (!this.pending) return;
    this.cancelTimer();
    this.sendNow();
  }

  /** Forget unsent changes; the app just replaced the document. */
  discard(): void {
    this.pending = false;
    this.cancelTimer();
  }

  private sendNow(): void {
    this.pending = false;
    this.send();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.pending) this.sendNow();
    }, this.intervalMs);
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
