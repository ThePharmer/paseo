import { afterEach, describe, expect, test, vi } from "vitest";
import { createGcSafetyNet, runGcSafetyNet, type GcSafetyNetPorts } from "./monitor";

const MB = 1024 * 1024;

interface FakeRuntimeOptions {
  hasStats?: boolean;
  hasBalloons?: boolean;
  hasGc?: boolean;
}

interface PressureCall {
  target: object;
  bytes: number;
}

const ARMED_PRESSURE_BYTES = 1;

// Simulates the pieces of Hermes, Expo, and Android the monitor reads: a
// clock, the native heap, instrumented GC stats, balloons with a native
// finalization signal, old-generation collections, and global.gc().
//
// External bytes follow Hermes: setPressure credits the difference from the
// object's previous amount, and a collected balloon debits its whole amount.
// Other external memory (ArrayBuffers, strings) shares the same counter.
// Only balloons the monitor has inflated and dropped are collectible; an
// armed balloon is still strongly held. A balloon inflated in the current task
// is still on the monitor's stack, so the collection that frees it comes in a
// later task. A collected balloon's token reports its id, unless Expo's
// construction wrapper still roots the token, in which case the id arrives
// only after Java finalizes the wrapper and a later collection runs.
function createFakeRuntime(options: FakeRuntimeOptions = {}) {
  const { hasStats = true, hasBalloons = true, hasGc = true } = options;
  let now = 0;
  let nativeHeapBytes = 200 * MB;
  let lastInteractionAt = Number.NEGATIVE_INFINITY;
  let otherExternalBytes = 0;
  let tokensHeldByWrapper = false;
  const stats = { numGCs: 0, heapSizeBytes: 30 * MB, gcTimeMs: 0 };
  const pressureCalls: PressureCall[] = [];
  const pressureByTarget = new Map<object, number>();
  const balloonIds = new Map<object, number>();
  const inflatedThisTask = new Set<object>();
  const wrapperHeldIds: number[] = [];
  let finalizedIds: number[] = [];
  const callLog: string[] = [];
  const gcCalls: number[] = [];
  const logs: string[] = [];
  let gcFreesTo: number | null = null;

  function nameOf(target: object): string {
    return `balloon${balloonIds.get(target) ?? "?"}`;
  }

  function readExternalBytes(): number {
    let total = otherExternalBytes;
    for (const bytes of pressureByTarget.values()) {
      total += bytes;
    }
    return total;
  }

  function collectOldGeneration(): void {
    if (!tokensHeldByWrapper) {
      finalizedIds.push(...wrapperHeldIds.splice(0));
    }
    for (const [target, bytes] of pressureByTarget) {
      if (bytes > ARMED_PRESSURE_BYTES && !inflatedThisTask.has(target)) {
        pressureByTarget.delete(target);
        const id = balloonIds.get(target) ?? -1;
        if (tokensHeldByWrapper) {
          wrapperHeldIds.push(id);
        } else {
          finalizedIds.push(id);
        }
      }
    }
    stats.numGCs += 1;
  }

  const ports: GcSafetyNetPorts = {
    now: () => now,
    readNativeHeapBytes: () => nativeHeapBytes,
    setPressure: (target, bytes) => {
      callLog.push(`pressure ${nameOf(target)} ${bytes}`);
      pressureCalls.push({ target, bytes });
      pressureByTarget.set(target, bytes);
      if (bytes > ARMED_PRESSURE_BYTES) {
        inflatedThisTask.add(target);
      }
    },
    readStats: hasStats
      ? () => {
          callLog.push("stats");
          return { ...stats, externalBytes: readExternalBytes() };
        }
      : null,
    balloons: hasBalloons
      ? {
          create: (id) => {
            const target = {};
            balloonIds.set(target, id);
            callLog.push(`create ${nameOf(target)}`);
            return target;
          },
          takeFinalizedIds: () => {
            callLog.push("take finalized");
            const taken = finalizedIds;
            finalizedIds = [];
            return taken;
          },
        }
      : null,
    collectGarbage: hasGc
      ? () => {
          callLog.push("gc");
          gcCalls.push(now);
          now += 150;
          collectOldGeneration();
          if (gcFreesTo !== null) {
            nativeHeapBytes = gcFreesTo;
          }
        }
      : null,
    readLastInteractionAt: () => lastInteractionAt,
    log: (line) => {
      callLog.push("log");
      logs.push(line);
    },
  };

  return {
    ports,
    pressureCalls,
    callLog,
    gcCalls,
    logs,
    readExternalBytes,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    // The timer task returns; the monitor's stack no longer holds anything.
    endTask() {
      inflatedThisTask.clear();
      callLog.push("end task");
    },
    setNativeHeapMb(mb: number) {
      nativeHeapBytes = mb * MB;
    },
    // External memory Hermes counts besides the balloons: strings, ArrayBuffers.
    setOtherExternalMb(mb: number) {
      otherExternalBytes = mb * MB;
    },
    // Expo's construction wrapper roots each token until Java finalizes it.
    holdTokensInWrappers(held: boolean) {
      tokensHeldByWrapper = held;
    },
    // Java finalizes the wrappers and a collection sweeps the held tokens.
    finalizeHeldTokens() {
      finalizedIds.push(...wrapperHeldIds.splice(0));
    },
    runYoungGc() {
      stats.numGCs += 1;
    },
    collectOldGeneration,
    setJsHeapMb(mb: number) {
      stats.heapSizeBytes = mb * MB;
    },
    interact() {
      lastInteractionAt = now;
    },
    gcFreesToMb(mb: number) {
      gcFreesTo = mb * MB;
    },
  };
}

type FakeRuntime = ReturnType<typeof createFakeRuntime>;

// Each poll is its own timer task.
function tickTask(runtime: FakeRuntime, net: { tick(): void }): void {
  net.tick();
  runtime.endTask();
}

// One poll per simulated second, like the production interval.
function runSeconds(runtime: FakeRuntime, net: { tick(): void }, seconds: number): void {
  for (let second = 0; second < seconds; second += 1) {
    runtime.advance(1000);
    tickTask(runtime, net);
  }
}

// Like runSeconds, but the user touches or scrolls right before every poll.
function runBusySeconds(runtime: FakeRuntime, net: { tick(): void }, seconds: number): void {
  for (let second = 0; second < seconds; second += 1) {
    runtime.advance(1000);
    runtime.interact();
    tickTask(runtime, net);
  }
}

/** The port calls made by the most recent task. */
function lastTaskCalls(runtime: FakeRuntime): string[] {
  const calls = runtime.callLog.slice(0, -1);
  const previousEnd = calls.lastIndexOf("end task");
  return calls.slice(previousEnd + 1);
}

function startedNet(runtime: FakeRuntime) {
  const net = createGcSafetyNet(runtime.ports);
  tickTask(runtime, net);
  return net;
}

function armedBalloonPressure(runtime: FakeRuntime): PressureCall {
  const call = runtime.pressureCalls[0];
  if (!call) {
    throw new Error("expected an armed balloon");
  }
  return call;
}

describe("gc safety net balloon", () => {
  test("arms one balloon at pressure 1 and does nothing while growth stays under the threshold", () => {
    const runtime = createFakeRuntime();
    const net = startedNet(runtime);
    runtime.runYoungGc();
    runtime.setNativeHeapMb(200 + 95);
    runSeconds(runtime, net, 5);

    expect(runtime.pressureCalls).toEqual([{ target: expect.any(Object), bytes: 1 }]);
    expect(net.readDiagnostics().events).toEqual([]);
  });

  test("waits for the armed balloon to ripen before triggering", () => {
    const runtime = createFakeRuntime();
    const net = startedNet(runtime);
    runtime.setNativeHeapMb(200 + 150);
    runSeconds(runtime, net, 3);

    expect(runtime.pressureCalls).toHaveLength(1);

    runtime.runYoungGc();
    runSeconds(runtime, net, 1);

    expect(runtime.pressureCalls).toHaveLength(3);
  });

  test("a trigger inflates the ripe balloon, drops it, and arms a new one", () => {
    const runtime = createFakeRuntime();
    const net = startedNet(runtime);
    const firstBalloon = armedBalloonPressure(runtime).target;
    runtime.runYoungGc();
    runtime.setJsHeapMb(40);
    runtime.setNativeHeapMb(200 + 150);
    runSeconds(runtime, net, 1);

    expect(runtime.pressureCalls.slice(1)).toEqual([
      { target: expect.any(Object), bytes: 1 },
      { target: firstBalloon, bytes: 150 * MB },
    ]);
    expect(runtime.pressureCalls[1]?.target).not.toBe(firstBalloon);
    expect(net.readDiagnostics().events).toEqual([
      {
        kind: "trigger",
        at: 1000,
        nativeHeapBytes: 350 * MB,
        baselineBytes: 200 * MB,
        pressureBytes: 150 * MB,
        stats: { numGCs: 1, heapSizeBytes: 40 * MB, gcTimeMs: 0, externalBytes: 1 },
      },
    ]);
    expect(runtime.logs).toHaveLength(1);
  });

  test("a trigger applies pressure as its last call, after the new balloon and all bookkeeping", () => {
    const runtime = createFakeRuntime();
    const net = startedNet(runtime);
    runtime.runYoungGc();
    runtime.setNativeHeapMb(200 + 150);
    runSeconds(runtime, net, 1);

    expect(lastTaskCalls(runtime)).toEqual([
      "stats",
      "take finalized",
      "create balloon2",
      "pressure balloon2 1",
      "log",
      `pressure balloon1 ${150 * MB}`,
    ]);
  });

  test("pressure is at least twice the JS heap and at most 1 GB", () => {
    const small = createFakeRuntime();
    const smallNet = startedNet(small);
    small.runYoungGc();
    small.setJsHeapMb(80);
    small.setNativeHeapMb(200 + 100);
    runSeconds(small, smallNet, 1);

    const large = createFakeRuntime();
    const largeNet = startedNet(large);
    large.runYoungGc();
    large.setNativeHeapMb(200 + 1500);
    runSeconds(large, largeNet, 1);

    expect(small.pressureCalls[2]?.bytes).toBe(160 * MB);
    expect(large.pressureCalls[2]?.bytes).toBe(1024 * MB);
  });
});

function triggeredNet(runtime: FakeRuntime) {
  const net = startedNet(runtime);
  runtime.runYoungGc();
  runtime.setNativeHeapMb(200 + 150);
  runSeconds(runtime, net, 1);
  expect(net.readDiagnostics().events.map((event) => event.kind)).toEqual(["trigger"]);
  return net;
}

describe("gc safety net collection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("detects the collection from the dropped balloon's own finalization signal", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.setOtherExternalMb(200);
    runSeconds(runtime, net, 2);

    expect(net.readDiagnostics().events.map((event) => event.kind)).toEqual(["trigger"]);

    runtime.collectOldGeneration();
    runSeconds(runtime, net, 1);

    expect(net.readDiagnostics().events.at(-1)).toMatchObject({
      kind: "collected",
      at: 4000,
      stats: { externalBytes: 200 * MB + 1 },
    });
  });

  test("unrelated external memory being freed neither confirms a collection nor allows overlapping pressure", () => {
    const runtime = createFakeRuntime();
    runtime.setOtherExternalMb(300);
    const net = triggeredNet(runtime);
    runtime.setOtherExternalMb(0);
    runtime.runYoungGc();
    runtime.setNativeHeapMb(200 + 300);
    runSeconds(runtime, net, 8);

    expect(runtime.pressureCalls.filter((call) => call.bytes > 1)).toHaveLength(1);
    expect(net.readDiagnostics().events.map((event) => event.kind)).toEqual(["trigger"]);
  });

  test("a completed forced collection clears a balloon whose signal never came, so triggers resume", () => {
    const runtime = createFakeRuntime();
    runtime.holdTokensInWrappers(true);
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runtime.gcFreesToMb(260);
    runSeconds(runtime, net, 12);
    runtime.runYoungGc();
    runtime.setNativeHeapMb(260 + 150);
    runSeconds(runtime, net, 1);

    expect(net.readDiagnostics().events.map((event) => [event.kind, event.at])).toEqual([
      ["trigger", 1000],
      ["fallback-gc", 11_000],
      ["trigger", 14_150],
    ]);
  });

  test("a late signal from an earlier balloon does not confirm the current one", () => {
    const runtime = createFakeRuntime();
    runtime.holdTokensInWrappers(true);
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runtime.gcFreesToMb(260);
    runSeconds(runtime, net, 12);
    runtime.runYoungGc();
    runtime.setNativeHeapMb(260 + 150);
    runSeconds(runtime, net, 1);
    runtime.finalizeHeldTokens();
    runSeconds(runtime, net, 5);

    expect(net.readDiagnostics().events.map((event) => event.kind)).toEqual([
      "trigger",
      "fallback-gc",
      "trigger",
    ]);
  });

  test("never constructs a WeakRef or reads one through a full cycle", () => {
    let constructed = 0;
    vi.stubGlobal("WeakRef", function countingWeakRef() {
      constructed += 1;
    });
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runSeconds(runtime, net, 10);
    runSeconds(runtime, net, 5);

    expect(net.readDiagnostics().events.map((event) => event.kind)).toEqual([
      "trigger",
      "fallback-gc",
    ]);
    expect(constructed).toBe(0);
  });

  test("triggers again after each detected collection without escalating pressure", () => {
    const runtime = createFakeRuntime();
    const net = startedNet(runtime);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      runtime.runYoungGc();
      runtime.setNativeHeapMb(200 + 150);
      runSeconds(runtime, net, 1);
      runtime.collectOldGeneration();
      runtime.setNativeHeapMb(200);
      runSeconds(runtime, net, 5);
    }

    const inflations = runtime.pressureCalls.filter((call) => call.bytes > 1);
    expect(inflations.map((call) => call.bytes)).toEqual([150 * MB, 150 * MB, 150 * MB]);
    expect(runtime.readExternalBytes()).toBe(1);
    expect(net.readDiagnostics().events.map((event) => event.kind)).toEqual([
      "trigger",
      "collected",
      "rebaseline",
      "trigger",
      "collected",
      "rebaseline",
      "trigger",
      "collected",
      "rebaseline",
    ]);
  });

  test("rebaselines 2 s after the dropped balloon is collected", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runSeconds(runtime, net, 2);
    runtime.collectOldGeneration();
    runtime.setNativeHeapMb(230);
    runSeconds(runtime, net, 1);
    runtime.setNativeHeapMb(220);
    runSeconds(runtime, net, 1);

    expect(net.readDiagnostics().baselineBytes).toBe(200 * MB);

    runSeconds(runtime, net, 1);

    expect(net.readDiagnostics()).toMatchObject({
      baselineBytes: 220 * MB,
      events: [
        { kind: "trigger", at: 1000 },
        { kind: "collected", at: 4000, sinceTriggerMs: 3000, nativeHeapBytes: 230 * MB },
        { kind: "rebaseline", at: 6000, baselineBytes: 220 * MB },
      ],
    });
  });

  test("does not trigger again while the dropped balloon is uncollected", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.runYoungGc();
    runtime.setNativeHeapMb(200 + 300);
    runSeconds(runtime, net, 8);

    expect(net.readDiagnostics().events.map((event) => event.kind)).toEqual(["trigger"]);
  });

  test("keeps at least 5 s between triggers", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.collectOldGeneration();
    runtime.setNativeHeapMb(200);
    runSeconds(runtime, net, 3);
    runtime.setNativeHeapMb(200 + 150);
    runSeconds(runtime, net, 1);

    expect(net.readDiagnostics().events.map((event) => [event.kind, event.at])).toEqual([
      ["trigger", 1000],
      ["collected", 2000],
      ["rebaseline", 4000],
    ]);

    runSeconds(runtime, net, 1);

    expect(net.readDiagnostics().events.at(-1)).toMatchObject({ kind: "trigger", at: 6000 });
  });

  test("keeps only the latest 50 events", () => {
    const runtime = createFakeRuntime();
    const net = startedNet(runtime);
    for (let cycle = 0; cycle < 20; cycle += 1) {
      runtime.runYoungGc();
      runtime.setNativeHeapMb(200 + 150);
      runSeconds(runtime, net, 1);
      runtime.collectOldGeneration();
      runtime.setNativeHeapMb(200);
      runSeconds(runtime, net, 5);
    }

    const events = net.readDiagnostics().events;
    expect(events).toHaveLength(50);
    expect(events.at(-1)?.kind).toBe("rebaseline");
  });
});

describe("gc safety net fallback", () => {
  test("forces a collection when growth stays over 400 MB for 10 s after a trigger", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runSeconds(runtime, net, 9);

    expect(runtime.gcCalls).toEqual([]);

    runtime.gcFreesToMb(260);
    runSeconds(runtime, net, 1);

    expect(runtime.gcCalls).toEqual([11_000]);
    expect(net.readDiagnostics()).toMatchObject({
      baselineBytes: 260 * MB,
      events: [
        { kind: "trigger", at: 1000 },
        {
          kind: "fallback-gc",
          at: 11_000,
          pauseMs: 150,
          nativeHeapBeforeBytes: 650 * MB,
          nativeHeapAfterBytes: 260 * MB,
        },
      ],
    });
    expect(runtime.logs).toHaveLength(2);
  });

  test("a tick that forces a collection ends there, and its balloon's signal after it is ignored", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runtime.gcFreesToMb(260);
    runSeconds(runtime, net, 10);

    expect(runtime.gcCalls).toEqual([11_000]);
    expect(lastTaskCalls(runtime)).toEqual(["stats", "gc", "stats", "log"]);
    expect(net.readDiagnostics().events.at(-1)?.kind).toBe("fallback-gc");

    runSeconds(runtime, net, 2);

    expect(net.readDiagnostics()).toMatchObject({
      baselineBytes: 260 * MB,
      events: [
        { kind: "trigger", at: 1000 },
        { kind: "fallback-gc", at: 11_000 },
      ],
    });
  });

  test("does not force a collection once the dropped balloon is collected", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runSeconds(runtime, net, 4);
    runtime.collectOldGeneration();
    runSeconds(runtime, net, 11);

    expect(runtime.gcCalls).toEqual([]);
    expect(net.readDiagnostics().baselineBytes).toBe(650 * MB);
  });

  test("in fallback-only mode, forces a collection after growth stays over 400 MB for 10 s", () => {
    const runtime = createFakeRuntime({ hasStats: false });
    const net = startedNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runSeconds(runtime, net, 5);
    runtime.setNativeHeapMb(200 + 350);
    runSeconds(runtime, net, 1);
    runtime.setNativeHeapMb(200 + 450);
    runSeconds(runtime, net, 10);

    expect(runtime.gcCalls).toEqual([]);

    runSeconds(runtime, net, 1);

    expect(runtime.gcCalls).toEqual([17_000]);
    expect(runtime.pressureCalls).toEqual([]);
  });

  test("waits for 500 ms without touch, scroll, or keyboard motion", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runSeconds(runtime, net, 9);
    runtime.advance(600);
    runtime.interact();
    runtime.advance(400);
    tickTask(runtime, net);

    expect(runtime.gcCalls).toEqual([]);

    runtime.advance(100);
    tickTask(runtime, net);

    expect(runtime.gcCalls).toEqual([11_100]);
    expect(net.readDiagnostics().events.at(-1)).toMatchObject({
      kind: "fallback-gc",
      reason: "quiet",
    });
  });

  test("collects despite continuous activity once the fallback has been deferred for 10 s", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runBusySeconds(runtime, net, 19);

    expect(runtime.gcCalls).toEqual([]);

    runBusySeconds(runtime, net, 1);

    expect(runtime.gcCalls).toEqual([21_000]);
    expect(net.readDiagnostics().events.at(-1)).toMatchObject({
      kind: "fallback-gc",
      at: 21_000,
      reason: "deferred-too-long",
    });
  });

  test("collects despite continuous activity as soon as it is due when growth passes 700 MB", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 750);
    runBusySeconds(runtime, net, 9);

    expect(runtime.gcCalls).toEqual([]);

    runBusySeconds(runtime, net, 1);

    expect(runtime.gcCalls).toEqual([11_000]);
    expect(net.readDiagnostics().events.at(-1)).toMatchObject({
      kind: "fallback-gc",
      reason: "emergency-growth",
    });
  });

  test("the deferral clock restarts when growth drops back under 400 MB", () => {
    const runtime = createFakeRuntime();
    const net = triggeredNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runBusySeconds(runtime, net, 15);
    runtime.setNativeHeapMb(200 + 350);
    runBusySeconds(runtime, net, 1);
    runtime.setNativeHeapMb(200 + 450);
    runBusySeconds(runtime, net, 10);

    expect(runtime.gcCalls).toEqual([]);

    runBusySeconds(runtime, net, 1);

    expect(runtime.gcCalls).toEqual([28_000]);
  });

  test("forces at most one collection per 60 s", () => {
    const runtime = createFakeRuntime({ hasStats: false });
    const net = startedNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runSeconds(runtime, net, 11);

    expect(runtime.gcCalls).toEqual([11_000]);

    runtime.setNativeHeapMb(200 + 450 + 450);
    runSeconds(runtime, net, 59);

    expect(runtime.gcCalls).toEqual([11_000]);

    runSeconds(runtime, net, 1);

    expect(runtime.gcCalls).toEqual([11_000, 71_150]);
  });
});

describe("gc safety net degradation", () => {
  test("without Hermes stats it runs fallback-only and still forces collections", () => {
    const runtime = createFakeRuntime({ hasStats: false });
    const net = startedNet(runtime);
    runtime.setNativeHeapMb(200 + 450);
    runSeconds(runtime, net, 11);

    expect(runtime.pressureCalls).toEqual([]);
    expect(runtime.gcCalls).toEqual([11_000]);
    expect(net.readDiagnostics()).toMatchObject({
      mode: "fallback-only",
      notes: [
        "HermesInternal.getInstrumentedStats with js_numGCs and js_externalBytes unavailable: balloon disabled",
      ],
      events: [{ kind: "fallback-gc", stats: null }],
    });
  });

  test("without the native balloon token it runs fallback-only and says why", () => {
    const runtime = createFakeRuntime({ hasBalloons: false });
    const net = startedNet(runtime);

    expect(runtime.pressureCalls).toEqual([]);
    expect(net.readDiagnostics()).toMatchObject({
      mode: "fallback-only",
      notes: ["PaseoGcPressure has no GcBalloonToken: balloon disabled"],
    });
  });

  test("with neither the balloon nor global.gc it does nothing", () => {
    const runtime = createFakeRuntime({ hasStats: false, hasGc: false });
    const net = startedNet(runtime);
    runtime.setNativeHeapMb(200 + 900);
    runSeconds(runtime, net, 30);

    expect(runtime.pressureCalls).toEqual([]);
    expect(net.readDiagnostics()).toEqual({
      mode: "off",
      notes: [
        "HermesInternal.getInstrumentedStats with js_numGCs and js_externalBytes unavailable: balloon disabled",
        "global.gc unavailable: fallback disabled",
      ],
      baselineBytes: null,
      nativeHeapBytes: null,
      events: [],
    });
  });
});

function createFakeScheduler() {
  const runs: Array<{ run: () => void; intervalMs: number; cancelled: boolean }> = [];
  return {
    runs,
    schedule(run: () => void, intervalMs: number) {
      const entry = { run, intervalMs, cancelled: false };
      runs.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

describe("gc safety net runner", () => {
  test("polls every second until stopped", () => {
    const runtime = createFakeRuntime();
    const scheduler = createFakeScheduler();
    const handle = runGcSafetyNet({
      enabled: true,
      ports: runtime.ports,
      schedule: scheduler.schedule,
    });

    expect(scheduler.runs.map((entry) => [entry.intervalMs, entry.cancelled])).toEqual([
      [1000, false],
    ]);

    scheduler.runs[0]?.run();
    expect(handle.readDiagnostics()).toMatchObject({ mode: "balloon", baselineBytes: 200 * MB });

    handle.stop();
    expect(scheduler.runs[0]?.cancelled).toBe(true);
  });

  test("the kill switch keeps it from starting", () => {
    const runtime = createFakeRuntime();
    const scheduler = createFakeScheduler();
    const handle = runGcSafetyNet({
      enabled: false,
      ports: runtime.ports,
      schedule: scheduler.schedule,
    });
    handle.stop();

    expect(scheduler.runs).toEqual([]);
    expect(runtime.pressureCalls).toEqual([]);
    expect(handle.readDiagnostics()).toEqual({
      mode: "off",
      notes: ["disabled by GC_SAFETY_NET_ENABLED"],
      baselineBytes: null,
      nativeHeapBytes: null,
      events: [],
    });
  });

  test("does not poll when neither the balloon nor global.gc is available", () => {
    const runtime = createFakeRuntime({ hasStats: false, hasGc: false });
    const scheduler = createFakeScheduler();
    const handle = runGcSafetyNet({
      enabled: true,
      ports: runtime.ports,
      schedule: scheduler.schedule,
    });

    expect(scheduler.runs).toEqual([]);
    expect(handle.readDiagnostics().mode).toBe("off");
  });

  test("an APK without the native module leaves it off", () => {
    const scheduler = createFakeScheduler();
    const handle = runGcSafetyNet({ enabled: true, ports: null, schedule: scheduler.schedule });

    expect(scheduler.runs).toEqual([]);
    expect(handle.readDiagnostics()).toMatchObject({
      mode: "off",
      notes: ["native module PaseoGcPressure missing"],
    });
  });
});
