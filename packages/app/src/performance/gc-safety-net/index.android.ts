import { requireOptionalNativeModule } from "expo-modules-core";
import { KeyboardEvents } from "react-native-keyboard-controller";
import { resolveHermesGcTools } from "./hermes";
import {
  markKeyboardMotionEnd,
  markKeyboardMotionStart,
  readLastInteractionAt,
} from "./interaction";
import {
  GC_SAFETY_NET_ENABLED,
  runGcSafetyNet,
  type GcBalloonPorts,
  type GcSafetyNetDiagnostics,
  type GcSafetyNetHandle,
  type GcSafetyNetPorts,
  type IntervalSchedule,
} from "./monitor";

interface PaseoGcPressureModule {
  nativeHeapBytes(): number;
  setPressure(target: object, bytes: number): void;
  // Missing on an APK built before the balloon token existed.
  GcBalloonToken?: new (id: number) => object;
  takeFinalizedBalloonTokenIds?: () => number[];
}

// Null on an APK built before the module existed.
const gcPressureModule = requireOptionalNativeModule<PaseoGcPressureModule>("PaseoGcPressure");

export { markInteraction, markScrollInteraction } from "./interaction";

let current: GcSafetyNetHandle | null = null;

// The balloon is a plain object holding the token, never the token itself:
// Expo's class constructor keeps a strong wrapper around the object it
// constructs until Java finalizes that wrapper, which would root a balloon.
function createBalloonPorts(gcPressure: PaseoGcPressureModule): GcBalloonPorts | null {
  const { GcBalloonToken, takeFinalizedBalloonTokenIds } = gcPressure;
  if (!GcBalloonToken || !takeFinalizedBalloonTokenIds) {
    return null;
  }
  return {
    create: (id) => ({ token: new GcBalloonToken(id) }),
    takeFinalizedIds: () => takeFinalizedBalloonTokenIds.call(gcPressure),
  };
}

function createPorts(gcPressure: PaseoGcPressureModule): GcSafetyNetPorts {
  return {
    now: () => performance.now(),
    readNativeHeapBytes: () => gcPressure.nativeHeapBytes(),
    setPressure: (target, bytes) => gcPressure.setPressure(target, bytes),
    balloons: createBalloonPorts(gcPressure),
    ...resolveHermesGcTools(globalThis),
    readLastInteractionAt: () => readLastInteractionAt(performance.now()),
    log: (line) => console.info(line),
  };
}

const scheduleInterval: IntervalSchedule = (run, intervalMs) => {
  const id = setInterval(run, intervalMs);
  return () => clearInterval(id);
};

function subscribeKeyboardMotion(): () => void {
  const subscriptions = [
    KeyboardEvents.addListener("keyboardWillShow", markKeyboardMotionStart),
    KeyboardEvents.addListener("keyboardWillHide", markKeyboardMotionStart),
    KeyboardEvents.addListener("keyboardDidShow", markKeyboardMotionEnd),
    KeyboardEvents.addListener("keyboardDidHide", markKeyboardMotionEnd),
  ];
  return () => {
    for (const subscription of subscriptions) {
      subscription.remove();
    }
  };
}

export function startGcSafetyNet(): () => void {
  const handle = runGcSafetyNet({
    enabled: GC_SAFETY_NET_ENABLED,
    ports: gcPressureModule ? createPorts(gcPressureModule) : null,
    schedule: scheduleInterval,
  });
  current = handle;
  const isRunning = handle.readDiagnostics().mode !== "off";
  const unsubscribeKeyboard = isRunning ? subscribeKeyboardMotion() : null;
  return () => {
    handle.stop();
    unsubscribeKeyboard?.();
  };
}

export function readGcSafetyNetDiagnostics(): GcSafetyNetDiagnostics {
  if (current === null) {
    return {
      mode: "off",
      notes: ["not started"],
      baselineBytes: null,
      nativeHeapBytes: null,
      events: [],
    };
  }
  return current.readDiagnostics();
}
