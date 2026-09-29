import { afterEach, expect, test, vi } from "vitest";
import {
  createDelayedSyncNotice,
  monotonicNoticeTimers,
  NOTICE_MIN_VISIBLE_MS,
  RECONNECTING_SHOW_DELAY_MS,
  UPDATING_SHOW_DELAY_MS,
  type SyncNotice,
  type SyncNoticeSignal,
} from "./sync-status-timing";

const updating: SyncNoticeSignal = { notice: "updating", immediate: false };
const reconnecting: SyncNoticeSignal = { notice: "reconnecting", immediate: false };
const hostUnreachable: SyncNoticeSignal = { notice: "reconnecting", immediate: true };

const ONE_HOUR_MS = 60 * 60 * 1_000;
const clockJumps = [
  { direction: "back", jumpMs: -ONE_HOUR_MS },
  { direction: "forward", jumpMs: ONE_HOUR_MS },
];

afterEach(() => {
  vi.useRealTimers();
});

// Timers run on elapsed time; `jumpClock` moves only what `now()` reports, the way a
// wall-clock change moves Date.now() without moving pending timeouts.
class NoticeClock {
  private nowMs = 0;
  private clockOffsetMs = 0;
  private timers: Array<{ dueAt: number; task: () => void }> = [];
  readonly shown: Array<SyncNotice | null> = [];
  readonly notice = createDelayedSyncNotice({
    ports: {
      now: () => this.nowMs + this.clockOffsetMs,
      schedule: (task, delayMs) => {
        const timer = { dueAt: this.nowMs + delayMs, task };
        this.timers.push(timer);
        return () => {
          this.timers = this.timers.filter((candidate) => candidate !== timer);
        };
      },
    },
    onChange: (notice) => this.shown.push(notice),
  });

  advance(elapsedMs: number): void {
    const target = this.nowMs + elapsedMs;
    for (;;) {
      const next = this.timers
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.nowMs = next.dueAt;
      next.task();
    }
    this.nowMs = target;
  }

  jumpClock(offsetMs: number): void {
    this.clockOffsetMs += offsetMs;
  }

  current(): SyncNotice | null {
    return this.shown.at(-1) ?? null;
  }
}

test("a catch-up that settles within the show delay never shows", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", updating);
  clock.advance(UPDATING_SHOW_DELAY_MS - 1);
  clock.notice.update("agent-a", null);
  clock.advance(5_000);

  expect(clock.shown).toEqual([]);
});

test("a catch-up still running after the show delay shows for at least the minimum time", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", updating);
  clock.advance(UPDATING_SHOW_DELAY_MS);
  expect(clock.current()).toBe("updating");

  clock.advance(10);
  clock.notice.update("agent-a", null);
  clock.advance(NOTICE_MIN_VISIBLE_MS - 11);
  expect(clock.current()).toBe("updating");
  clock.advance(1);

  expect(clock.shown).toEqual(["updating", null]);
});

test("a notice that outlives the minimum time hides as soon as the chat is current", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", updating);
  clock.advance(UPDATING_SHOW_DELAY_MS + NOTICE_MIN_VISIBLE_MS + 100);
  clock.notice.update("agent-a", null);

  expect(clock.shown).toEqual(["updating", null]);
});

test("reconnecting waits longer than updating before it shows", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", reconnecting);
  clock.advance(RECONNECTING_SHOW_DELAY_MS - 1);
  expect(clock.shown).toEqual([]);
  clock.advance(1);

  expect(clock.shown).toEqual(["reconnecting"]);
});

test("a known unreachable host shows reconnecting at once", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", reconnecting);
  clock.advance(200);
  clock.notice.update("agent-a", hostUnreachable);

  expect(clock.shown).toEqual(["reconnecting"]);
});

test("the delay counts from when the chat stopped being current, not from the latest label", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", reconnecting);
  clock.advance(300);
  clock.notice.update("agent-a", updating);
  expect(clock.shown).toEqual([]);
  clock.advance(UPDATING_SHOW_DELAY_MS - 300);

  expect(clock.shown).toEqual(["updating"]);
});

test("a shown notice switches label at once and keeps a fresh minimum time", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", hostUnreachable);
  clock.advance(2_000);
  clock.notice.update("agent-a", updating);
  expect(clock.current()).toBe("updating");
  clock.notice.update("agent-a", null);
  clock.advance(NOTICE_MIN_VISIBLE_MS - 1);
  expect(clock.current()).toBe("updating");
  clock.advance(1);

  expect(clock.shown).toEqual(["reconnecting", "updating", null]);
});

test("a status that returns during the minimum time keeps the notice up", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", updating);
  clock.advance(UPDATING_SHOW_DELAY_MS);
  clock.notice.update("agent-a", null);
  clock.advance(100);
  clock.notice.update("agent-a", updating);
  clock.advance(NOTICE_MIN_VISIBLE_MS);

  expect(clock.shown).toEqual(["updating"]);
});

test("switching panes drops the shown notice and restarts the delay for the new pane", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", updating);
  clock.advance(UPDATING_SHOW_DELAY_MS);
  clock.notice.update("agent-b", updating);
  expect(clock.shown).toEqual(["updating", null]);
  clock.advance(UPDATING_SHOW_DELAY_MS - 1);
  expect(clock.current()).toBeNull();
  clock.advance(1);

  expect(clock.shown).toEqual(["updating", null, "updating"]);
});

test("switching panes cancels a pending show for the previous pane", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", reconnecting);
  clock.advance(RECONNECTING_SHOW_DELAY_MS - 100);
  clock.notice.update("agent-b", null);
  clock.advance(5_000);

  expect(clock.shown).toEqual([]);
});

test("time in the background does not count toward the show delay", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", reconnecting);
  clock.advance(RECONNECTING_SHOW_DELAY_MS - 100);
  clock.notice.setVisible(false);
  clock.advance(30_000);
  clock.notice.setVisible(true);
  expect(clock.shown).toEqual([]);
  clock.advance(RECONNECTING_SHOW_DELAY_MS - 1);
  expect(clock.shown).toEqual([]);
  clock.advance(1);

  expect(clock.shown).toEqual(["reconnecting"]);
});

test("a chat that stops being current in the background starts its delay on return", () => {
  const clock = new NoticeClock();
  clock.notice.setVisible(false);
  clock.notice.update("agent-a", reconnecting);
  clock.advance(5_000);
  clock.notice.update("agent-a", updating);
  clock.advance(5_000);
  clock.notice.setVisible(true);
  clock.advance(UPDATING_SHOW_DELAY_MS - 1);
  expect(clock.shown).toEqual([]);
  clock.advance(1);

  expect(clock.shown).toEqual(["updating"]);
});

test("a chat that recovers soon after the return never shows the notice that fell due in the background", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", reconnecting);
  clock.notice.setVisible(false);
  clock.advance(60_000);
  clock.notice.setVisible(true);
  clock.advance(RECONNECTING_SHOW_DELAY_MS - 1);
  clock.notice.update("agent-a", null);
  clock.advance(5_000);

  expect(clock.shown).toEqual([]);
});

test("a known unreachable host waits for the return and then shows at once", () => {
  const clock = new NoticeClock();
  clock.notice.setVisible(false);
  clock.notice.update("agent-a", hostUnreachable);
  clock.advance(5_000);
  expect(clock.shown).toEqual([]);
  clock.notice.setVisible(true);

  expect(clock.shown).toEqual(["reconnecting"]);
});

test("a notice shown before the app was hidden stays up on return", () => {
  const clock = new NoticeClock();
  clock.notice.update("agent-a", reconnecting);
  clock.advance(RECONNECTING_SHOW_DELAY_MS);
  clock.notice.setVisible(false);
  clock.advance(5_000);
  clock.notice.setVisible(true);
  clock.advance(5_000);

  expect(clock.shown).toEqual(["reconnecting"]);
});

test.each(clockJumps)(
  "a known unreachable host shows at once after the clock moves $direction",
  ({ jumpMs }) => {
    const clock = new NoticeClock();
    clock.notice.update("agent-a", updating);
    clock.advance(200);
    clock.jumpClock(jumpMs);
    clock.notice.update("agent-a", hostUnreachable);

    expect(clock.shown).toEqual(["reconnecting"]);
  },
);

test.each(clockJumps)(
  "a pending notice shows on time after the clock moves $direction",
  ({ jumpMs }) => {
    const clock = new NoticeClock();
    clock.notice.update("agent-a", updating);
    clock.advance(100);
    clock.jumpClock(jumpMs);
    clock.notice.update("agent-a", updating);
    clock.advance(UPDATING_SHOW_DELAY_MS - 101);
    expect(clock.shown).toEqual([]);
    clock.advance(1);

    expect(clock.shown).toEqual(["updating"]);
  },
);

test.each(clockJumps)(
  "a recovered chat hides after the minimum time when the clock moves $direction",
  ({ jumpMs }) => {
    const clock = new NoticeClock();
    clock.notice.update("agent-a", updating);
    clock.advance(UPDATING_SHOW_DELAY_MS);
    clock.jumpClock(jumpMs);
    clock.notice.update("agent-a", null);
    clock.advance(NOTICE_MIN_VISIBLE_MS - 1);
    expect(clock.current()).toBe("updating");
    clock.advance(1);

    expect(clock.shown).toEqual(["updating", null]);
  },
);

test.each(clockJumps)(
  "the app's notice timers ignore a system clock moved $direction",
  ({ jumpMs }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    const shown: Array<SyncNotice | null> = [];
    const notice = createDelayedSyncNotice({
      ports: monotonicNoticeTimers,
      onChange: (next) => shown.push(next),
    });
    notice.update("agent-a", updating);
    vi.advanceTimersByTime(100);
    vi.setSystemTime(Date.now() + jumpMs);
    notice.update("agent-a", reconnecting);
    vi.advanceTimersByTime(RECONNECTING_SHOW_DELAY_MS - 101);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(["reconnecting"]);

    vi.setSystemTime(Date.now() + jumpMs);
    notice.update("agent-a", null);
    vi.advanceTimersByTime(NOTICE_MIN_VISIBLE_MS - 1);
    expect(shown).toEqual(["reconnecting"]);
    vi.advanceTimersByTime(1);

    expect(shown).toEqual(["reconnecting", null]);
  },
);
