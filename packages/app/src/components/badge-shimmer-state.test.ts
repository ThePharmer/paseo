import { describe, expect, it } from "vitest";
import { getBadgeShimmerMotion } from "./badge-shimmer-state";

const geometry = { rowWidth: 120, peakWidth: 40 };

describe("native badge shimmer motion", () => {
  it("sweeps the peak from before the label to past it while on screen", () => {
    expect(getBadgeShimmerMotion({ ...geometry, isOnScreen: true, reduceMotion: false })).toEqual({
      kind: "sweeping",
      fromX: -40,
      toX: 160,
    });
  });

  it("pauses while off screen", () => {
    expect(getBadgeShimmerMotion({ ...geometry, isOnScreen: false, reduceMotion: false })).toEqual({
      kind: "paused",
    });
  });

  it.each([true, false])(
    "rests past the label with no sweep when Reduce Motion is on (on screen: %s)",
    (isOnScreen) => {
      expect(getBadgeShimmerMotion({ ...geometry, isOnScreen, reduceMotion: true })).toEqual({
        kind: "resting",
        translateX: 160,
      });
    },
  );
});
