export const SYNCED_LOADER_DURATION_MS = 950;
export const SYNCED_LOADER_DOT_COUNT = 6;

const SYNCED_LOADER_OPACITY_STATES = [
  [1, 0, 0.78, 0, 0.56, 0.34],
  [0.78, 1, 0.56, 0, 0.34, 0],
  [0.56, 0.78, 0.34, 1, 0, 0],
  [0.34, 0.56, 0, 0.78, 0, 1],
  [0, 0.34, 0, 0.56, 1, 0.78],
  [0, 0, 1, 0.34, 0.78, 0.56],
] as const;

export interface SyncedLoaderGrid {
  gap: number;
  dotSize: number;
  gridWidth: number;
  gridHeight: number;
}

export function getSyncedLoaderGrid(size: number): SyncedLoaderGrid {
  // The 2x3 grid fills `size` exactly on its long axis: the dot is whatever is left after
  // the two gaps, not a floored integer. Flooring cost the grid up to a third of a dot per
  // row: at size 10 it drew 8pt of ink in a 10pt box and read as a small mark in a large
  // slot. Fractional dots are fine here; these are sub-pixel radii on a moving glyph.
  const gap = Math.max(1, Math.round(size * 0.12));
  const dotSize = Math.max(2, (size - gap * 2) / 3);
  return { gap, dotSize, gridWidth: dotSize * 2 + gap, gridHeight: dotSize * 3 + gap * 2 };
}

export function getSyncedLoaderStep(nowMs: number): number {
  "worklet";
  const elapsedMs = nowMs % SYNCED_LOADER_DURATION_MS;
  return Math.floor((elapsedMs * SYNCED_LOADER_DOT_COUNT) / SYNCED_LOADER_DURATION_MS);
}

export function getSyncedLoaderDotOpacity(step: number, dot: number): number {
  "worklet";
  return SYNCED_LOADER_OPACITY_STATES[step]?.[dot] ?? 0;
}

// Width of the ramp into each step, in steps. At 950 ms per cycle it is 0.16 ms, so on screen each
// step switches in one frame, like the wall-clock step it replaces.
const STEP_EDGE = 0.001;

export interface SyncedLoaderDotInterpolation {
  inputRange: number[];
  outputRange: number[];
}

/** One dot's opacity over a progress that counts steps from 0 up to the dot count. */
export function getSyncedLoaderDotInterpolation(dot: number): SyncedLoaderDotInterpolation {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let step = 0; step < SYNCED_LOADER_DOT_COUNT; step += 1) {
    const opacity = getSyncedLoaderDotOpacity(step, dot);
    inputRange.push(step, step + 1 - STEP_EDGE);
    outputRange.push(opacity, opacity);
  }
  return { inputRange, outputRange };
}
