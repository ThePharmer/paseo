import type { GcSafetyNetPorts, HermesGcStats } from "./monitor";

export type HermesGcTools = Pick<GcSafetyNetPorts, "readStats" | "collectGarbage">;

const MS_PER_SECOND = 1000;

function readNumberField(source: object, key: string): number | null {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "number" ? value : null;
}

function parseHermesGcStats(value: unknown): HermesGcStats | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const numGCs = readNumberField(value, "js_numGCs");
  const gcTimeSeconds = readNumberField(value, "js_gcTime");
  const heapSizeBytes = readNumberField(value, "js_heapSize");
  const externalBytes = readNumberField(value, "js_externalBytes");
  const hasGcFields =
    numGCs !== null && gcTimeSeconds !== null && heapSizeBytes !== null && externalBytes !== null;
  if (!hasGcFields) {
    return null;
  }
  return { numGCs, gcTimeMs: gcTimeSeconds * MS_PER_SECOND, heapSizeBytes, externalBytes };
}

function resolveStatsReader(runtimeGlobal: object): (() => HermesGcStats) | null {
  const hermes: unknown = Reflect.get(runtimeGlobal, "HermesInternal");
  if (typeof hermes !== "object" || hermes === null) {
    return null;
  }
  const getInstrumentedStats: unknown = Reflect.get(hermes, "getInstrumentedStats");
  if (typeof getInstrumentedStats !== "function") {
    return null;
  }
  const readRaw = (): unknown => Reflect.apply(getInstrumentedStats, hermes, []);
  const initial = parseHermesGcStats(readRaw());
  if (initial === null) {
    return null;
  }
  // The shape was checked once; if a later read is malformed, keep the last
  // good sample instead of throwing from a timer.
  let latest: HermesGcStats = initial;
  return () => {
    latest = parseHermesGcStats(readRaw()) ?? latest;
    return latest;
  };
}

function resolveCollectGarbage(runtimeGlobal: object): (() => void) | null {
  const gc: unknown = Reflect.get(runtimeGlobal, "gc");
  if (typeof gc !== "function") {
    return null;
  }
  return () => {
    Reflect.apply(gc, runtimeGlobal, []);
  };
}

/**
 * Probes the Hermes features the GC safety net needs. HermesInternal can be
 * disabled and global.gc removed, so each one may be missing.
 */
export function resolveHermesGcTools(runtimeGlobal: object): HermesGcTools {
  return {
    readStats: resolveStatsReader(runtimeGlobal),
    collectGarbage: resolveCollectGarbage(runtimeGlobal),
  };
}
