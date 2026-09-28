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
    WeakRef,
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

  test("calls global.gc and wraps WeakRef", () => {
    const { runtimeGlobal, gcCalls } = createHermesGlobal(HERMES_STATS);
    const tools = resolveHermesGcTools(runtimeGlobal);
    const target = {};
    tools.collectGarbage?.();

    expect(gcCalls).toEqual(["gc"]);
    expect(tools.createWeakRef?.(target).deref()).toBe(target);
  });

  test("reports each tool missing on a runtime without Hermes, gc, or WeakRef", () => {
    expect(resolveHermesGcTools({})).toEqual({
      readStats: null,
      createWeakRef: null,
      collectGarbage: null,
    });
  });

  test("treats stats without the GC fields as missing", () => {
    const { runtimeGlobal } = createHermesGlobal({ js_heapSize: 1 });

    expect(resolveHermesGcTools(runtimeGlobal).readStats).toBeNull();
  });
});
