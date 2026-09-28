import { describe, expect, test } from "vitest";
import { readGcSafetyNetDiagnostics, startGcSafetyNet } from "./index";

describe("gc safety net outside Android", () => {
  test("starting and stopping is a no-op and diagnostics report it off", () => {
    const stop = startGcSafetyNet();
    stop();

    expect(readGcSafetyNetDiagnostics()).toEqual({
      mode: "off",
      notes: ["Android only"],
      baselineBytes: null,
      nativeHeapBytes: null,
      events: [],
    });
  });
});
