import { useLayoutEffect } from "react";
import { Animated, Easing } from "react-native";
import { createSharedLoop, type SharedLoop } from "./shared";

// React Native's native animated driver moves these values on the UI thread and writes each frame
// straight to the native view (FabricUIManager.synchronouslyUpdateViewOnUIThread), so a looping
// indicator costs no JS work and no shadow-tree commit per frame. A native loop also repeats on the
// UI thread without calling back into JS between iterations.

export interface NativeLoop {
  /** Runs from `span * phase` to `span * (phase + 1)` once per period, then repeats. */
  progress: Animated.Value;
  loop: SharedLoop;
}

interface NativeLoopOptions {
  periodMs: number;
  span: number;
}

export function createNativeLoop({ periodMs, span }: NativeLoopOptions): NativeLoop {
  const progress = new Animated.Value(0);
  let running: Animated.CompositeAnimation | null = null;

  const loop = createSharedLoop({
    periodMs,
    now: Date.now,
    driver: {
      start(phase) {
        const from = phase * span;
        progress.setValue(from);
        running = Animated.loop(
          Animated.timing(progress, {
            toValue: from + span,
            duration: periodMs,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
        );
        running.start();
      },
      stop() {
        if (running) running.stop();
        running = null;
      },
    },
  });

  return { progress, loop };
}

/** Keeps the shared loop running while this instance is on screen. */
export function useNativeLoop(loop: SharedLoop, isOnScreen: boolean): void {
  useLayoutEffect(() => {
    if (!isOnScreen) return;
    return loop.retain();
  }, [isOnScreen, loop]);
}
