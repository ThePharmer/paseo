// What the native tool badge shimmer does in a given state. Kept free of React Native so the rules
// are unit-tested.

export type BadgeShimmerMotion =
  // Off screen: the loop stops and the peak keeps its last position.
  | { kind: "paused" }
  // Reduce Motion: no sweep, the peak rests past the label so none of it shows. This is where the
  // earlier Reanimated shimmer settled, since its repeat jumped to the end under Reduce Motion.
  | { kind: "resting"; translateX: number }
  // The peak sweeps across the label from `fromX` to `toX`, then repeats.
  | { kind: "sweeping"; fromX: number; toX: number };

interface BadgeShimmerMotionInput {
  isOnScreen: boolean;
  reduceMotion: boolean;
  rowWidth: number;
  peakWidth: number;
}

export function getBadgeShimmerMotion({
  isOnScreen,
  reduceMotion,
  rowWidth,
  peakWidth,
}: BadgeShimmerMotionInput): BadgeShimmerMotion {
  const pastLabelX = rowWidth + peakWidth;
  if (reduceMotion) {
    return { kind: "resting", translateX: pastLabelX };
  }
  if (!isOnScreen) {
    return { kind: "paused" };
  }
  return { kind: "sweeping", fromX: -peakWidth, toX: pastLabelX };
}
