import { requireOptionalNativeModule } from "expo-modules-core";
import { KeyboardEvents } from "react-native-keyboard-controller";
import { resolveBalloonFinalizer } from "./balloon-finalizer";
import { resolveHermesGcTools } from "./hermes";
import {
  markKeyboardMotionEnd,
  markKeyboardMotionStart,
  readLastInteractionAt,
} from "./interaction";
import {
  GC_SAFETY_NET_ENABLED,
  runGcSafetyNet,
  type GcSafetyNetDiagnostics,
  type GcSafetyNetHandle,
  type GcSafetyNetPorts,
  type IntervalSchedule,
} from "./monitor";

interface PaseoGcPressureModule {
  nativeHeapBytes(): number;
  // Missing on an APK built before the balloon finalizer existed. Installs
  // global.__paseoGcBalloon on the JS thread; false if it could not.
  installBalloonFinalizer?: () => boolean;
}

// Null on an APK built before the module existed.
const gcPressureModule = requireOptionalNativeModule<PaseoGcPressureModule>("PaseoGcPressure");

export { markInteraction, markScrollInteraction } from "./interaction";

let current: GcSafetyNetHandle | null = null;

function createPorts(gcPressure: PaseoGcPressureModule): GcSafetyNetPorts {
  const { installBalloonFinalizer } = gcPressure;
  return {
    now: () => performance.now(),
    readNativeHeapBytes: () => gcPressure.nativeHeapBytes(),
    // Balloons are plain JSI objects: no Expo or Java wrapper ever holds one.
    balloons: resolveBalloonFinalizer({
      runtimeGlobal: globalThis,
      install: installBalloonFinalizer ? () => installBalloonFinalizer.call(gcPressure) : null,
    }),
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
    // Creating the ports installs the JSI global, so skip it when disabled.
    ports: GC_SAFETY_NET_ENABLED && gcPressureModule ? createPorts(gcPressureModule) : null,
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
