// Frees native memory that Hermes cannot see. Fabric keeps stale ShadowNode
// revisions alive through small JS wrappers until Hermes collects them, and
// Hermes does not count that native memory, so the native heap can outgrow the
// device while the JS heap looks idle. See docs/agent-stream-performance.md.

const MB = 1024 * 1024;

/** Kill switch. Set to false to ship a build without the safety net. */
export const GC_SAFETY_NET_ENABLED = true;

/** Debug.getNativeHeapAllocatedSize is a mallinfo read (microseconds on Scudo), so 1 s sees a fast ramp within one step. */
export const GC_SAFETY_NET_POLL_INTERVAL_MS = 1000;
/** Native growth that is worth a collection: well above normal streaming churn, far below the OOM range. */
export const TRIGGER_GROWTH_BYTES = 96 * MB;
/** External bytes must reach the old-generation target (about twice the live JS heap) on their own to start a collection. */
export const PRESSURE_HEAP_MULTIPLIER = 2;
/** Keeps each credit well under Hermes' maxHeapSize (3 GB in RN) check and inside a Kotlin Int. */
export const MAX_PRESSURE_BYTES = 1024 * MB;
/** Gives finalizers and Fabric time to release native memory after the sweep, so the baseline is the new floor. */
export const REBASELINE_DELAY_MS = 2000;
/** A single old-generation collection takes a few seconds on a phone; triggering faster only stacks pressure. */
export const MIN_TRIGGER_INTERVAL_MS = 5000;
/** Native growth at which a missed collection risks a Scudo OOM abort (seen at 2.5 GB RSS). */
export const FALLBACK_GROWTH_BYTES = 400 * MB;
/** How long the balloon gets to work before a forced collection. */
export const FALLBACK_WAIT_MS = 10_000;
/** global.gc() blocks the JS thread; never run it inside a gesture, scroll, or keyboard animation. */
export const FALLBACK_QUIET_MS = 500;
/** A forced full collection is a visible pause; bound how often the app pays it. */
export const FALLBACK_MIN_INTERVAL_MS = 60_000;
/** Enough history to read a streaming session from the diagnostics sheet. */
export const EVENT_RING_SIZE = 50;
/** An armed balloon carries a token amount so its NativeState exists before it is needed. */
const ARMED_PRESSURE_BYTES = 1;

export interface HermesGcStats {
  numGCs: number;
  heapSizeBytes: number;
  gcTimeMs: number;
  externalBytes: number;
}

export interface WeakTarget {
  deref(): object | undefined;
}

export interface GcSafetyNetPorts {
  /** Monotonic milliseconds. */
  now(): number;
  readNativeHeapBytes(): number;
  setPressure(target: object, bytes: number): void;
  /** Null when HermesInternal.getInstrumentedStats is missing. */
  readStats: (() => HermesGcStats) | null;
  /** Null when the runtime has no WeakRef. */
  createWeakRef: ((target: object) => WeakTarget) | null;
  /** Null when global.gc is missing. */
  collectGarbage: (() => void) | null;
  /** Monotonic milliseconds of the latest touch, scroll, or keyboard motion. */
  readLastInteractionAt(): number;
  log(line: string): void;
}

export type GcSafetyNetMode = "balloon" | "fallback-only" | "off";

export interface GcTriggerEvent {
  kind: "trigger";
  at: number;
  nativeHeapBytes: number;
  baselineBytes: number;
  pressureBytes: number;
  stats: HermesGcStats;
}

export interface GcCollectedEvent {
  kind: "collected";
  at: number;
  sinceTriggerMs: number;
  nativeHeapBytes: number;
  stats: HermesGcStats | null;
}

export interface GcRebaselineEvent {
  kind: "rebaseline";
  at: number;
  baselineBytes: number;
  stats: HermesGcStats | null;
}

export interface GcFallbackEvent {
  kind: "fallback-gc";
  at: number;
  pauseMs: number;
  nativeHeapBeforeBytes: number;
  nativeHeapAfterBytes: number;
  stats: HermesGcStats | null;
}

export type GcSafetyNetEvent =
  | GcTriggerEvent
  | GcCollectedEvent
  | GcRebaselineEvent
  | GcFallbackEvent;

export interface GcSafetyNetDiagnostics {
  mode: GcSafetyNetMode;
  /** Why the net runs degraded or not at all. */
  notes: string[];
  baselineBytes: number | null;
  nativeHeapBytes: number | null;
  events: GcSafetyNetEvent[];
}

export interface GcSafetyNet {
  tick(): void;
  readDiagnostics(): GcSafetyNetDiagnostics;
}

export interface GcSafetyNetHandle {
  stop(): void;
  readDiagnostics(): GcSafetyNetDiagnostics;
}

/** Runs `run` every `intervalMs` and returns a cancel function. */
export type IntervalSchedule = (run: () => void, intervalMs: number) => () => void;

interface Balloon {
  target: object;
  // Created at arming, never in the trigger task: see arm().
  ref: WeakTarget;
  armedAtNumGCs: number;
}

interface ReleasedBalloon {
  ref: WeakTarget;
  triggeredAt: number;
}

function describeMissingCapabilities(ports: GcSafetyNetPorts): string[] {
  const notes: string[] = [];
  if (ports.readStats === null) {
    notes.push("HermesInternal.getInstrumentedStats unavailable: balloon disabled");
  }
  if (ports.createWeakRef === null) {
    notes.push("WeakRef unavailable: balloon disabled");
  }
  if (ports.collectGarbage === null) {
    notes.push("global.gc unavailable: fallback disabled");
  }
  return notes;
}

// Ripeness needs js_numGCs and collection needs a WeakRef; the balloon runs
// only with both.
function resolveBalloonWeakRef(ports: GcSafetyNetPorts): ((target: object) => WeakTarget) | null {
  return ports.readStats === null ? null : ports.createWeakRef;
}

function resolveMode(input: { hasBalloon: boolean; hasGc: boolean }): GcSafetyNetMode {
  if (input.hasBalloon) {
    return "balloon";
  }
  return input.hasGc ? "fallback-only" : "off";
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / MB)}MB`;
}

export function createGcSafetyNet(ports: GcSafetyNetPorts): GcSafetyNet {
  const createBalloonRef = resolveBalloonWeakRef(ports);
  const mode = resolveMode({
    hasBalloon: createBalloonRef !== null,
    hasGc: ports.collectGarbage !== null,
  });
  const notes = describeMissingCapabilities(ports);
  const events: GcSafetyNetEvent[] = [];

  let baselineBytes: number | null = null;
  let nativeHeapBytes: number | null = null;
  let armed: Balloon | null = null;
  let released: ReleasedBalloon | null = null;
  let rebaselineAt: number | null = null;
  let lastTriggerAt: number | null = null;
  let highGrowthSince: number | null = null;
  let lastFallbackAt: number | null = null;

  function record(event: GcSafetyNetEvent): void {
    events.push(event);
    if (events.length > EVENT_RING_SIZE) {
      events.shift();
    }
  }

  // Hermes keeps a WeakRef's target strongly reachable until the task that
  // constructed it drains its microtasks (lib/VM/JSLib/WeakRef.cpp:78). A
  // WeakRef built in the trigger task would root the balloon through the very
  // collection its pressure starts, so the ref is built here, ticks earlier.
  function arm(createRef: (target: object) => WeakTarget, stats: HermesGcStats): Balloon {
    const target = {};
    const ref = createRef(target);
    ports.setPressure(target, ARMED_PRESSURE_BYTES);
    return { target, ref, armedAtNumGCs: stats.numGCs };
  }

  // A dropped balloon still holds its pressure until it is collected, so a
  // second trigger before then would stack pressure and inflate the next
  // old-generation target.
  function canTrigger(at: number): boolean {
    const isSettled = released === null && rebaselineAt === null;
    const isSpaced = lastTriggerAt === null || at - lastTriggerAt >= MIN_TRIGGER_INTERVAL_MS;
    return isSettled && isSpaced;
  }

  function observeCollection(at: number, heap: number, stats: HermesGcStats): void {
    if (released === null || released.ref.deref() !== undefined) {
      return;
    }
    record({
      kind: "collected",
      at,
      sinceTriggerMs: at - released.triggeredAt,
      nativeHeapBytes: heap,
      stats,
    });
    released = null;
    rebaselineAt = at + REBASELINE_DELAY_MS;
  }

  function rebaselineIfDue(at: number, heap: number, stats: HermesGcStats | null): void {
    if (rebaselineAt === null || at < rebaselineAt) {
      return;
    }
    rebaselineAt = null;
    baselineBytes = heap;
    record({ kind: "rebaseline", at, baselineBytes: heap, stats });
  }

  function trigger(input: {
    createRef: (target: object) => WeakTarget;
    balloon: Balloon;
    at: number;
    heap: number;
    baseline: number;
    stats: HermesGcStats;
  }): void {
    const { createRef, balloon, at, heap, baseline, stats } = input;
    const growth = heap - baseline;
    const heapScaled = PRESSURE_HEAP_MULTIPLIER * stats.heapSizeBytes;
    const pressureBytes = Math.min(Math.max(growth, heapScaled), MAX_PRESSURE_BYTES);
    released = { ref: balloon.ref, triggeredAt: at };
    armed = arm(createRef, stats);
    lastTriggerAt = at;
    record({
      kind: "trigger",
      at,
      nativeHeapBytes: heap,
      baselineBytes: baseline,
      pressureBytes,
      stats,
    });
    ports.log(
      `[GcSafetyNet] trigger growth=${formatMb(growth)} pressure=${formatMb(pressureBytes)} ` +
        `nativeHeap=${formatMb(heap)} jsHeap=${formatMb(stats.heapSizeBytes)} numGCs=${stats.numGCs}`,
    );
    // Pressure goes last. Once the credit puts the old generation over its
    // target, HadesGC::creditExternalMemory moves the young-gen limit to the
    // current level (lib/VM/gcs/HadesGC.cpp:1929-1933), so the next JS
    // allocation runs a young collection that starts old-gen marking. Marking
    // roots whatever is live at that moment, and a surviving balloon's pressure
    // lands in the next target (HadesGC.cpp:1227-1236). Every allocation (the
    // new balloon, its WeakRef, the event, the log line) happens above, and
    // the callers return without allocating, so the only strong references
    // left are this frame's, gone when the tick returns.
    ports.setPressure(balloon.target, pressureBytes);
  }

  function tickBalloon(input: {
    createRef: (target: object) => WeakTarget;
    at: number;
    heap: number;
    baseline: number;
    stats: HermesGcStats;
  }): void {
    const { createRef, at, heap, baseline, stats } = input;
    if (armed === null) {
      armed = arm(createRef, stats);
      return;
    }
    // A balloon that has survived a collection lives in the old generation,
    // so only an old-generation collection can free it and its pressure.
    const isRipe = stats.numGCs > armed.armedAtNumGCs;
    const growth = heap - baseline;
    if (growth > TRIGGER_GROWTH_BYTES && isRipe && canTrigger(at)) {
      // Must stay the last statement: see the ordering note in trigger().
      trigger({ createRef, balloon: armed, at, heap, baseline, stats });
    }
  }

  // The balloon gets FALLBACK_WAIT_MS to be collected. Without a balloon, the
  // growth itself has to hold for that long.
  function readFallbackWaitStart(): number | null {
    if (mode === "balloon") {
      return released === null ? null : released.triggeredAt;
    }
    return highGrowthSince;
  }

  function isFallbackDue(at: number, growth: number): boolean {
    const waitStart = readFallbackWaitStart();
    const hasWaited = waitStart !== null && at - waitStart >= FALLBACK_WAIT_MS;
    const isQuiet = at - ports.readLastInteractionAt() >= FALLBACK_QUIET_MS;
    const isSpaced = lastFallbackAt === null || at - lastFallbackAt >= FALLBACK_MIN_INTERVAL_MS;
    return growth > FALLBACK_GROWTH_BYTES && hasWaited && isQuiet && isSpaced;
  }

  function forceCollection(collectGarbage: () => void, at: number, heapBefore: number): void {
    const startedAt = ports.now();
    collectGarbage();
    const pauseMs = ports.now() - startedAt;
    const heapAfter = ports.readNativeHeapBytes();
    const stats = ports.readStats === null ? null : ports.readStats();
    nativeHeapBytes = heapAfter;
    baselineBytes = heapAfter;
    highGrowthSince = null;
    lastFallbackAt = at;
    record({
      kind: "fallback-gc",
      at,
      pauseMs,
      nativeHeapBeforeBytes: heapBefore,
      nativeHeapAfterBytes: heapAfter,
      stats,
    });
    ports.log(
      `[GcSafetyNet] fallback gc pause=${Math.round(pauseMs)}ms ` +
        `nativeHeap=${formatMb(heapBefore)}->${formatMb(heapAfter)}`,
    );
  }

  function trackHighGrowth(at: number, growth: number): void {
    if (growth <= FALLBACK_GROWTH_BYTES) {
      highGrowthSince = null;
    } else if (highGrowthSince === null) {
      highGrowthSince = at;
    }
  }

  // Order matters twice here. deref() of a live target keeps it strongly
  // reachable until the task drains its microtasks (lib/VM/JSLib/WeakRef.cpp:104),
  // so a due fallback runs before any deref and the tick that ran it does not
  // deref at all; the next tick observes the collection. And the balloon step
  // runs last, because a trigger must not be followed by an allocation.
  function tick(): void {
    if (mode === "off") {
      return;
    }
    const at = ports.now();
    const heap = ports.readNativeHeapBytes();
    const stats = ports.readStats === null ? null : ports.readStats();
    nativeHeapBytes = heap;
    rebaselineIfDue(at, heap, stats);
    // Follow the floor down so a startup peak does not hide later growth.
    const baseline = baselineBytes === null ? heap : Math.min(baselineBytes, heap);
    baselineBytes = baseline;
    const growth = heap - baseline;
    trackHighGrowth(at, growth);
    if (ports.collectGarbage && isFallbackDue(at, growth)) {
      forceCollection(ports.collectGarbage, at, heap);
      return;
    }
    if (createBalloonRef && stats) {
      observeCollection(at, heap, stats);
      tickBalloon({ createRef: createBalloonRef, at, heap, baseline, stats });
    }
  }

  function readDiagnostics(): GcSafetyNetDiagnostics {
    return { mode, notes: [...notes], baselineBytes, nativeHeapBytes, events: [...events] };
  }

  return { tick, readDiagnostics };
}

function createInertHandle(note: string): GcSafetyNetHandle {
  const diagnostics: GcSafetyNetDiagnostics = {
    mode: "off",
    notes: [note],
    baselineBytes: null,
    nativeHeapBytes: null,
    events: [],
  };
  return {
    stop() {},
    readDiagnostics: () => ({ ...diagnostics, notes: [...diagnostics.notes] }),
  };
}

export function runGcSafetyNet(input: {
  enabled: boolean;
  /** Null when the APK predates the PaseoGcPressure module. */
  ports: GcSafetyNetPorts | null;
  schedule: IntervalSchedule;
}): GcSafetyNetHandle {
  if (!input.enabled) {
    return createInertHandle("disabled by GC_SAFETY_NET_ENABLED");
  }
  if (input.ports === null) {
    return createInertHandle("native module PaseoGcPressure missing");
  }
  const net = createGcSafetyNet(input.ports);
  if (net.readDiagnostics().mode === "off") {
    return { stop() {}, readDiagnostics: net.readDiagnostics };
  }
  const cancel = input.schedule(net.tick, GC_SAFETY_NET_POLL_INTERVAL_MS);
  return { stop: cancel, readDiagnostics: net.readDiagnostics };
}
