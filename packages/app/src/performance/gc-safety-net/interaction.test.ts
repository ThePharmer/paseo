import { afterEach, describe, expect, test, vi } from "vitest";
import { markInteraction, markScrollInteraction, readLastInteractionAt } from "./interaction";

function setClock(ms: number): void {
  vi.spyOn(performance, "now").mockReturnValue(ms);
}

describe("gc safety net interaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a programmatic scroll does not count as interaction", () => {
    setClock(1000);
    markInteraction();
    setClock(5000);
    markScrollInteraction({ isUserDriven: false });

    expect(readLastInteractionAt(6000)).toBe(1000);
  });

  test("a user-driven scroll counts as interaction", () => {
    setClock(1000);
    markInteraction();
    setClock(5000);
    markScrollInteraction({ isUserDriven: true });

    expect(readLastInteractionAt(6000)).toBe(5000);
  });
});
