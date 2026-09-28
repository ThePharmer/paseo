// When the user last touched, scrolled, or moved the keyboard, so the GC
// safety net never forces a blocking collection in the middle of one. Writers
// are hot paths (every chat scroll event), so each mark is one clock read.
//
// Hooks: touch start/end on the root view (app/_layout.tsx), chat list scroll
// events (agent-stream/strategy-native.tsx), and keyboard show/hide events
// (subscribed by index.android.ts). Callers import markInteraction from the
// module entry, which makes it a no-op off Android.

/** Longest keyboard animation to treat as ongoing, in case its end event never arrives. */
const KEYBOARD_MOTION_MAX_MS = 1000;

let lastInteractionAt = Number.NEGATIVE_INFINITY;
let keyboardMotionStartedAt: number | null = null;

export function markInteraction(): void {
  lastInteractionAt = performance.now();
}

export function markKeyboardMotionStart(): void {
  const now = performance.now();
  lastInteractionAt = now;
  keyboardMotionStartedAt = now;
}

export function markKeyboardMotionEnd(): void {
  lastInteractionAt = performance.now();
  keyboardMotionStartedAt = null;
}

/** A keyboard animation in flight counts as an interaction happening now. */
export function readLastInteractionAt(now: number): number {
  const isKeyboardMoving =
    keyboardMotionStartedAt !== null && now - keyboardMotionStartedAt < KEYBOARD_MOTION_MAX_MS;
  return isKeyboardMoving ? now : lastInteractionAt;
}
