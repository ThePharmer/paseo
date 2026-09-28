import type { GcBalloonPorts } from "./monitor";

/**
 * The global that modules/paseo-gc-pressure/cpp/balloon-finalizer.cpp installs.
 * pressure-module-contract.test.ts checks these names against the C++ source.
 */
export const BALLOON_GLOBAL_NAME = "__paseoGcBalloon";
export const BALLOON_FUNCTION_NAMES = ["create", "setPressure", "takeFinalizedIds"] as const;

type BalloonFunctionName = (typeof BALLOON_FUNCTION_NAMES)[number];

function readFunction(source: object, name: BalloonFunctionName): Function | null {
  const value: unknown = Reflect.get(source, name);
  return typeof value === "function" ? value : null;
}

function readIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((id): id is number => typeof id === "number");
}

/**
 * Installs the native balloon finalizer and returns the balloon ports, or null
 * when the APK has no install function, the install fails, or the global it
 * leaves behind is incomplete.
 */
export function resolveBalloonFinalizer(input: {
  runtimeGlobal: object;
  install: (() => boolean) | null;
}): GcBalloonPorts | null {
  const { runtimeGlobal, install } = input;
  if (install === null || install() !== true) {
    return null;
  }
  const api: unknown = Reflect.get(runtimeGlobal, BALLOON_GLOBAL_NAME);
  if (typeof api !== "object" || api === null) {
    return null;
  }
  const create = readFunction(api, "create");
  const setPressure = readFunction(api, "setPressure");
  const takeFinalizedIds = readFunction(api, "takeFinalizedIds");
  if (create === null || setPressure === null || takeFinalizedIds === null) {
    return null;
  }
  return {
    create: (id) => {
      const balloon: unknown = Reflect.apply(create, api, [id]);
      if (typeof balloon !== "object" || balloon === null) {
        throw new Error("__paseoGcBalloon.create returned no object");
      }
      return balloon;
    },
    setPressure: (balloon, bytes) => {
      Reflect.apply(setPressure, api, [balloon, bytes]);
    },
    takeFinalizedIds: () => readIds(Reflect.apply(takeFinalizedIds, api, [])),
  };
}
