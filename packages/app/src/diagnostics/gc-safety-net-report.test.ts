import { describe, expect, test } from "vitest";
import { formatGcSafetyNetSection } from "./app-diagnostic-report";

const MB = 1024 * 1024;

describe("GC safety net diagnostics report", () => {
  test("formats GC safety net events one per line", () => {
    const stats = { numGCs: 41, heapSizeBytes: 60 * MB, gcTimeMs: 812.4, externalBytes: 2 * MB };
    const report = formatGcSafetyNetSection({
      mode: "balloon",
      notes: [],
      baselineBytes: 300 * MB,
      nativeHeapBytes: 310 * MB,
      events: [
        {
          kind: "trigger",
          at: 123_456,
          nativeHeapBytes: 512 * MB,
          baselineBytes: 300 * MB,
          pressureBytes: 212 * MB,
          stats,
        },
        { kind: "collected", at: 126_156, sinceTriggerMs: 2700, nativeHeapBytes: 280 * MB, stats },
        { kind: "rebaseline", at: 128_156, baselineBytes: 270 * MB, stats: null },
        {
          kind: "fallback-gc",
          at: 200_000,
          reason: "deferred-too-long",
          pauseMs: 181.6,
          nativeHeapBeforeBytes: 900 * MB,
          nativeHeapAfterBytes: 500 * MB,
          stats,
        },
      ],
    });

    expect(report).toBe(
      [
        "GC safety net",
        "  Mode: balloon",
        "  Notes: none",
        "  Native heap: 310MB",
        "  Baseline: 300MB",
        "  Event 1: t+123.5s trigger nativeHeap=512MB baseline=300MB pressure=212MB numGCs=41 gcTime=812ms jsHeap=60MB external=2MB",
        "  Event 2: t+126.2s collected after=2.7s nativeHeap=280MB numGCs=41 gcTime=812ms jsHeap=60MB external=2MB",
        "  Event 3: t+128.2s rebaseline baseline=270MB stats=unavailable",
        "  Event 4: t+200.0s fallback-gc reason=deferred-too-long pause=182ms nativeHeap=900MB->500MB numGCs=41 gcTime=812ms jsHeap=60MB external=2MB",
      ].join("\n"),
    );
  });

  test("says why the GC safety net is off", () => {
    const report = formatGcSafetyNetSection({
      mode: "off",
      notes: ["native module PaseoGcPressure missing"],
      baselineBytes: null,
      nativeHeapBytes: null,
      events: [],
    });

    expect(report).toBe(
      [
        "GC safety net",
        "  Mode: off",
        "  Notes: native module PaseoGcPressure missing",
        "  Native heap: unknown",
        "  Baseline: unknown",
        "  Events: none",
      ].join("\n"),
    );
  });
});
