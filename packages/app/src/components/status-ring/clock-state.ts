// The native ring clock's schedule: when its UI-thread frame loop runs and which frames publish a
// new rotation. Kept free of Reanimated so the worklets in `clock.ts` and the tests share it.

// The ring turns 400°/s (one 900 ms period, see geometry.ts). At 30 updates a second each step is
// 13.3°, about 1.2 dp at the stroke of the 12 dp ring, which still reads as continuous rotation.
// 30 is also the lowest rate that lands on the same vsync every time at 60, 90 and 120 Hz (every
// 2nd, 3rd and 4th frame); the next rates with that property, 15 and 10, move the quarter arc by
// more than a quarter of its own length per step. A visible ring therefore redraws the window 30
// times a second instead of at display rate.
export const STATUS_RING_UPDATES_PER_SECOND = 30;
const STATUS_RING_UPDATE_INTERVAL_MS = 1000 / STATUS_RING_UPDATES_PER_SECOND;

// Frame timestamps sit on the vsync grid, so the frame that completes an interval can land a
// fraction of a millisecond before it (four 120 Hz frames are not exactly 1000 / 30 ms in floating
// point, and vsync periods drift slightly). Accepting frames this early keeps publishing on that
// frame instead of slipping to the next one. It is far below the shortest frame we expect (6.9 ms
// at 144 Hz), so it never picks the frame before.
const FRAME_TIMESTAMP_TOLERANCE_MS = 1;

export interface StatusRingClock {
  // Rings currently registered as on screen.
  visibleRings: number;
  // A frame callback is pending. Only a frame clears this, so a ring that leaves the screen and
  // another that arrives before the next frame keep the one loop instead of starting a second.
  running: boolean;
  lastUpdateFrameMs: number;
}

export const IDLE_STATUS_RING_CLOCK: StatusRingClock = {
  visibleRings: 0,
  running: false,
  lastUpdateFrameMs: Number.NEGATIVE_INFINITY,
};

export interface StatusRingShowTransition {
  clock: StatusRingClock;
  startLoop: boolean;
}

export type StatusRingFrameAction = "publish" | "skip" | "stop";

export interface StatusRingFrameTransition {
  clock: StatusRingClock;
  action: StatusRingFrameAction;
}

export function showStatusRing(clock: StatusRingClock): StatusRingShowTransition {
  "worklet";
  return {
    clock: { ...clock, visibleRings: clock.visibleRings + 1, running: true },
    startLoop: !clock.running,
  };
}

export function hideStatusRing(clock: StatusRingClock): StatusRingClock {
  "worklet";
  return { ...clock, visibleRings: clock.visibleRings - 1 };
}

export function advanceStatusRingClock(
  clock: StatusRingClock,
  frameTimestampMs: number,
): StatusRingFrameTransition {
  "worklet";
  if (clock.visibleRings === 0) {
    return { clock: { ...clock, running: false }, action: "stop" };
  }

  const elapsedMs = frameTimestampMs - clock.lastUpdateFrameMs;
  if (elapsedMs < STATUS_RING_UPDATE_INTERVAL_MS - FRAME_TIMESTAMP_TOLERANCE_MS) {
    return { clock, action: "skip" };
  }

  return { clock: { ...clock, lastUpdateFrameMs: frameTimestampMs }, action: "publish" };
}
