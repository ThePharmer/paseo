import type { FileEditorClock } from "@/file-pane/editor/model";

interface ScheduledTimer {
  id: number;
  at: number;
  callback: () => void;
}

/** A clock whose timers fire only when a test advances time. */
export class ManualClock implements FileEditorClock {
  private now = 0;
  private nextId = 1;
  private timers: ScheduledTimer[] = [];

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + delayMs, callback });
    return toHandle(id);
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers = this.timers.filter((timer) => toHandle(timer.id) !== handle);
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.now = due.at;
      due.callback();
    }
    this.now = target;
  }
}

function toHandle(id: number): ReturnType<typeof setTimeout> {
  // Timer handles are opaque; callers only hand them back to clearTimeout.
  return id as unknown as ReturnType<typeof setTimeout>;
}
