import type { GcSafetyNetDiagnostics } from "./monitor";

// The native memory the safety net reclaims is an Android Fabric problem, and
// its native module ships only in the Android build. index.android.ts is the
// real entry; iOS and web get this no-op.

function stopNothing(): void {}

export function markInteraction(): void {}

export function startGcSafetyNet(): () => void {
  return stopNothing;
}

export function readGcSafetyNetDiagnostics(): GcSafetyNetDiagnostics {
  return {
    mode: "off",
    notes: ["Android only"],
    baselineBytes: null,
    nativeHeapBytes: null,
    events: [],
  };
}
