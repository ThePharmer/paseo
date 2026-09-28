import { describe, expect, test } from "vitest";
import { BALLOON_GLOBAL_NAME, resolveBalloonFinalizer } from "./balloon-finalizer";
import { createGcSafetyNet } from "./monitor";

const MB = 1024 * 1024;

// Stands in for cpp/balloon-finalizer.cpp on a Hermes runtime. A balloon is a
// plain object; the runtime keeps its id and pressure the way a NativeState
// would, invisible to JS. collect() frees every balloon the test has dropped,
// debits its pressure, and runs its finalizer in that same collection.
function createFakeJsiRuntime() {
  const runtimeGlobal: Record<string, unknown> = {};
  const idByBalloon = new Map<object, number>();
  const pressureByBalloon = new Map<object, number>();
  const dropped = new Set<object>();
  let finalizedIds: number[] = [];
  let installs = 0;

  function install(): boolean {
    installs += 1;
    runtimeGlobal[BALLOON_GLOBAL_NAME] = {
      create(id: number): object {
        const balloon = {};
        idByBalloon.set(balloon, id);
        return balloon;
      },
      setPressure(balloon: object, bytes: number): void {
        pressureByBalloon.set(balloon, bytes);
      },
      takeFinalizedIds(): number[] {
        const taken = finalizedIds;
        finalizedIds = [];
        return taken;
      },
    };
    return true;
  }

  return {
    runtimeGlobal,
    install,
    get installs() {
      return installs;
    },
    externalBytes(): number {
      let total = 0;
      for (const bytes of pressureByBalloon.values()) {
        total += bytes;
      }
      return total;
    },
    pressureOf(balloon: object): number | undefined {
      return pressureByBalloon.get(balloon);
    },
    balloonWithId(id: number): object {
      for (const [balloon, balloonId] of idByBalloon) {
        if (balloonId === id) {
          return balloon;
        }
      }
      throw new Error(`no balloon ${id}`);
    },
    drop(balloon: object): void {
      dropped.add(balloon);
    },
    collect(): void {
      for (const balloon of dropped) {
        pressureByBalloon.delete(balloon);
        finalizedIds.push(idByBalloon.get(balloon) ?? -1);
        idByBalloon.delete(balloon);
      }
      dropped.clear();
    },
  };
}

describe("balloon finalizer install", () => {
  test("creates balloons whose ids arrive only once the runtime collects them", () => {
    const runtime = createFakeJsiRuntime();
    const balloons = resolveBalloonFinalizer({
      runtimeGlobal: runtime.runtimeGlobal,
      install: runtime.install,
    });
    if (balloons === null) {
      throw new Error("expected balloon ports");
    }
    const first = balloons.create(1);
    const second = balloons.create(2);
    balloons.setPressure(first, 64 * MB);
    balloons.setPressure(second, 1);

    expect(runtime.pressureOf(first)).toBe(64 * MB);
    expect(balloons.takeFinalizedIds()).toEqual([]);

    runtime.drop(first);

    expect(balloons.takeFinalizedIds()).toEqual([]);

    runtime.collect();

    expect(balloons.takeFinalizedIds()).toEqual([1]);
    expect(balloons.takeFinalizedIds()).toEqual([]);
    expect(runtime.externalBytes()).toBe(1);
  });

  test("an APK without the install function has no balloons", () => {
    const runtime = createFakeJsiRuntime();

    expect(resolveBalloonFinalizer({ runtimeGlobal: runtime.runtimeGlobal, install: null })).toBe(
      null,
    );
  });

  test("a failed install has no balloons, even if an old global is left behind", () => {
    const runtime = createFakeJsiRuntime();
    runtime.install();

    expect(
      resolveBalloonFinalizer({ runtimeGlobal: runtime.runtimeGlobal, install: () => false }),
    ).toBe(null);
  });

  test("an install that leaves an incomplete global has no balloons", () => {
    const runtimeGlobal: Record<string, unknown> = {};
    const install = (): boolean => {
      runtimeGlobal[BALLOON_GLOBAL_NAME] = { create: () => ({}), setPressure: () => {} };
      return true;
    };

    expect(resolveBalloonFinalizer({ runtimeGlobal, install })).toBe(null);
  });
});

describe("gc safety net on the balloon finalizer", () => {
  function createNet(runtime: ReturnType<typeof createFakeJsiRuntime>) {
    let now = 0;
    let nativeHeapBytes = 200 * MB;
    let numGCs = 0;
    const net = createGcSafetyNet({
      now: () => now,
      readNativeHeapBytes: () => nativeHeapBytes,
      balloons: resolveBalloonFinalizer({
        runtimeGlobal: runtime.runtimeGlobal,
        install: runtime.install,
      }),
      readStats: () => ({
        numGCs,
        heapSizeBytes: 30 * MB,
        gcTimeMs: 0,
        externalBytes: runtime.externalBytes(),
      }),
      collectGarbage: () => {},
      readLastInteractionAt: () => Number.NEGATIVE_INFINITY,
      log: () => {},
    });
    return {
      net,
      tickAfter(ms: number) {
        now += ms;
        net.tick();
      },
      setNativeHeapMb(mb: number) {
        nativeHeapBytes = mb * MB;
      },
      runYoungGc() {
        numGCs += 1;
      },
    };
  }

  test("runs in balloon mode after installing once", () => {
    const runtime = createFakeJsiRuntime();
    const { net } = createNet(runtime);

    expect(runtime.installs).toBe(1);
    expect(net.readDiagnostics()).toMatchObject({ mode: "balloon", notes: [] });
  });

  test("reports the collection in the first tick after the collection that frees the balloon", () => {
    const runtime = createFakeJsiRuntime();
    const driver = createNet(runtime);
    driver.tickAfter(0);
    driver.runYoungGc();
    driver.setNativeHeapMb(200 + 150);
    driver.tickAfter(1000);

    const dropped = runtime.balloonWithId(1);
    expect(runtime.pressureOf(dropped)).toBe(150 * MB);

    runtime.drop(dropped);
    runtime.collect();
    driver.tickAfter(1000);

    expect(driver.net.readDiagnostics().events.map((event) => [event.kind, event.at])).toEqual([
      ["trigger", 1000],
      ["collected", 2000],
    ]);
  });

  test("runs fallback-only when the install is unavailable", () => {
    const net = createGcSafetyNet({
      now: () => 0,
      readNativeHeapBytes: () => 200 * MB,
      balloons: resolveBalloonFinalizer({ runtimeGlobal: {}, install: null }),
      readStats: () => ({ numGCs: 0, heapSizeBytes: 30 * MB, gcTimeMs: 0, externalBytes: 0 }),
      collectGarbage: () => {},
      readLastInteractionAt: () => Number.NEGATIVE_INFINITY,
      log: () => {},
    });

    expect(net.readDiagnostics()).toMatchObject({
      mode: "fallback-only",
      notes: ["PaseoGcPressure balloon finalizer unavailable: balloon disabled"],
    });
  });
});
