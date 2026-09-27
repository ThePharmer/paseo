import { describe, expect, test } from "vitest";
import {
  advanceStatusRingClock,
  hideStatusRing,
  IDLE_STATUS_RING_CLOCK,
  showStatusRing,
  type StatusRingClock,
  type StatusRingFrameAction,
} from "./clock-state";

function showRings(count: number, clock: StatusRingClock = IDLE_STATUS_RING_CLOCK) {
  let current = clock;
  for (let ring = 0; ring < count; ring += 1) {
    current = showStatusRing(current).clock;
  }
  return current;
}

function vsyncTimestamps(input: { refreshHz: number; frames: number; startMs: number }): number[] {
  const periodMs = 1000 / input.refreshHz;
  return Array.from({ length: input.frames }, (_, frame) => input.startMs + frame * periodMs);
}

function runFrames(clock: StatusRingClock, timestamps: number[]) {
  let current = clock;
  const actions: StatusRingFrameAction[] = [];
  for (const timestamp of timestamps) {
    const frame = advanceStatusRingClock(current, timestamp);
    current = frame.clock;
    actions.push(frame.action);
  }
  return { clock: current, actions };
}

function publishingFrames(actions: StatusRingFrameAction[]): number[] {
  const frames: number[] = [];
  actions.forEach((action, frame) => {
    if (action === "publish") {
      frames.push(frame);
    }
  });
  return frames;
}

function everyNthFrame(step: number, frames: number): number[] {
  return Array.from({ length: Math.ceil(frames / step) }, (_, index) => index * step);
}

describe("status ring clock registration", () => {
  test("the first ring on screen starts the frame loop and later rings join it", () => {
    const first = showStatusRing(IDLE_STATUS_RING_CLOCK);
    const second = showStatusRing(first.clock);

    expect(first.startLoop).toBe(true);
    expect(second.startLoop).toBe(false);
    expect(second.clock).toEqual({
      visibleRings: 2,
      running: true,
      lastUpdateFrameMs: Number.NEGATIVE_INFINITY,
    });
  });

  test("the loop keeps running while any ring is still on screen", () => {
    const oneLeft = hideStatusRing(showRings(2));

    const { clock, actions } = runFrames(oneLeft, [1000, 1040]);

    expect(actions).toEqual(["publish", "publish"]);
    expect(clock.running).toBe(true);
  });

  test("the loop stops on the first frame after the last ring leaves the screen", () => {
    const hidden = hideStatusRing(showRings(1));

    const { clock, actions } = runFrames(hidden, [1000]);

    expect(actions).toEqual(["stop"]);
    expect(clock).toEqual({
      visibleRings: 0,
      running: false,
      lastUpdateFrameMs: Number.NEGATIVE_INFINITY,
    });
  });

  test("a ring that arrives before the pending frame joins the loop instead of starting a second", () => {
    const visible = runFrames(showRings(1), [1000]).clock;
    const replaced = showStatusRing(hideStatusRing(visible));

    const { actions } = runFrames(replaced.clock, [1040]);

    expect(replaced.startLoop).toBe(false);
    expect(actions).toEqual(["publish"]);
  });

  test("a ring that arrives after the loop stopped starts it again and publishes on its first frame", () => {
    const stopped = runFrames(hideStatusRing(showRings(1)), [1000]).clock;
    const restarted = showStatusRing(stopped);

    const { actions } = runFrames(restarted.clock, [5000]);

    expect(restarted.startLoop).toBe(true);
    expect(actions).toEqual(["publish"]);
  });
});

describe("status ring clock cadence", () => {
  test.each([
    { refreshHz: 60, step: 2 },
    { refreshHz: 90, step: 3 },
    { refreshHz: 120, step: 4 },
    { refreshHz: 144, step: 5 },
  ])("publishes on every $step frame at $refreshHz Hz", ({ refreshHz, step }) => {
    const timestamps = vsyncTimestamps({ refreshHz, frames: refreshHz, startMs: 123_456.789 });

    const { actions } = runFrames(showRings(1), timestamps);

    expect(publishingFrames(actions)).toEqual(everyNthFrame(step, refreshHz));
  });

  test("extra callbacks between frames do not publish before the interval has passed", () => {
    const timestamps = [1000, 1004, 1016.7, 1025, 1031, 1033.4];

    const { actions } = runFrames(showRings(1), timestamps);

    expect(actions).toEqual(["publish", "skip", "skip", "skip", "skip", "publish"]);
  });
});
