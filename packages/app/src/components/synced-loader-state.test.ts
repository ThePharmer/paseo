import { describe, expect, test } from "vitest";
import {
  getSyncedLoaderDotInterpolation,
  getSyncedLoaderDotOpacity,
  getSyncedLoaderStep,
} from "./synced-loader-state";

// Piecewise-linear evaluation, as React Native's interpolation node does between input stops.
function interpolate(range: { inputRange: number[]; outputRange: number[] }, input: number) {
  const { inputRange, outputRange } = range;
  let index = 1;
  while (index < inputRange.length - 1 && inputRange[index] < input) index += 1;
  const start = inputRange[index - 1];
  const end = inputRange[index];
  const fraction = (input - start) / (end - start);
  return outputRange[index - 1] + fraction * (outputRange[index] - outputRange[index - 1]);
}

describe("synced loader state", () => {
  test("advances through six wall-clock-aligned steps every 950 milliseconds", () => {
    const sampleTimes = [0, 158, 159, 316, 317, 474, 475, 633, 634, 791, 792, 949, 950];

    const steps = sampleTimes.map(getSyncedLoaderStep);

    expect(steps).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 0]);
  });

  test("preserves the six visible snake states", () => {
    const states: number[][] = [];
    for (let step = 0; step < 6; step += 1) {
      const dotOpacities: number[] = [];
      for (let dot = 0; dot < 6; dot += 1) {
        dotOpacities.push(getSyncedLoaderDotOpacity(step, dot));
      }
      states.push(dotOpacities);
    }

    expect(states).toEqual([
      [1, 0, 0.78, 0, 0.56, 0.34],
      [0.78, 1, 0.56, 0, 0.34, 0],
      [0.56, 0.78, 0.34, 1, 0, 0],
      [0.34, 0.56, 0, 0.78, 0, 1],
      [0, 0.34, 0, 0.56, 1, 0.78],
      [0, 0, 1, 0.34, 0.78, 0.56],
    ]);
  });

  test("holds each step's opacity across the whole step of a looping progress", () => {
    const steps = [0, 1, 2, 3, 4, 5];
    const heldOpacities: number[][] = [];
    const leadingEdges: number[][] = [];
    const expectedByDot: number[][] = [];
    for (let dot = 0; dot < 6; dot += 1) {
      const range = getSyncedLoaderDotInterpolation(dot);
      heldOpacities.push(steps.map((step) => interpolate(range, step + 0.99)));
      leadingEdges.push(steps.map((step) => interpolate(range, step)));
      expectedByDot.push(steps.map((step) => getSyncedLoaderDotOpacity(step, dot)));
    }

    expect(heldOpacities).toEqual(expectedByDot);
    expect(leadingEdges).toEqual(expectedByDot);
  });
});
