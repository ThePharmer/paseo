import { describe, expect, test } from "vitest";
import { resolveHermesGcTools } from "./hermes";

function createHermesGlobal(stats: Record<string, number>) {
  const gcCalls: string[] = [];
  const runtimeGlobal = {
    HermesInternal: {
      getInstrumentedStats: () => stats,
    },
    gc: () => {
      gcCalls.push("gc");
    },
  };
  return { runtimeGlobal, gcCalls };
}

const HERMES_STATS = {
  js_numGCs: 42,
  js_gcTime: 1.25,
  js_heapSize: 50_000_000,
  js_externalBytes: 3_000_000,
  js_allocatedBytes: 20_000_000,
};

describe("resolveHermesGcTools", () => {
  test("reads instrumented stats with js_gcTime converted from seconds to milliseconds", () => {
    const { runtimeGlobal } = createHermesGlobal(HERMES_STATS);
    const tools = resolveHermesGcTools(runtimeGlobal);

    expect(tools.readStats?.()).toEqual({
      numGCs: 42,
      gcTimeMs: 1250,
      heapSizeBytes: 50_000_000,
      externalBytes: 3_000_000,
    });
  });

  test("calls global.gc", () => {
    const { runtimeGlobal, gcCalls } = createHermesGlobal(HERMES_STATS);
    resolveHermesGcTools(runtimeGlobal).collectGarbage?.();

    expect(gcCalls).toEqual(["gc"]);
  });

  test("offers no WeakRef tool even when the runtime has WeakRef", () => {
    const { runtimeGlobal } = createHermesGlobal(HERMES_STATS);
    const tools = resolveHermesGcTools({ ...runtimeGlobal, WeakRef });

    expect(Object.keys(tools).sort()).toEqual(["collectGarbage", "readStats"]);
  });

  test("reports each tool missing on a runtime without Hermes or gc", () => {
    expect(resolveHermesGcTools({})).toEqual({
      readStats: null,
      collectGarbage: null,
    });
  });

  test("treats stats without the GC fields as missing", () => {
    const { runtimeGlobal } = createHermesGlobal({ js_heapSize: 1 });

    expect(resolveHermesGcTools(runtimeGlobal).readStats).toBeNull();
  });

  test("treats stats without js_externalBytes as missing, since the balloon detects collection from it", () => {
    const { js_externalBytes: _omitted, ...withoutExternal } = HERMES_STATS;
    const { runtimeGlobal } = createHermesGlobal(withoutExternal);

    expect(resolveHermesGcTools(runtimeGlobal).readStats).toBeNull();
  });
});
