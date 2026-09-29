import { useAnimatedReaction } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { createShadowTreeSync } from "./scheduler";

export const shadowTreeSync = createShadowTreeSync({
  requestFrame: (callback) => {
    requestAnimationFrame(callback);
  },
});

/** Put every settled Reanimated transform into the shadow tree on the next frame. */
export function requestShadowTreeSync(): void {
  shadowTreeSync.request();
}

/**
 * For a container whose transform animates on the UI thread and holds React Native touchables.
 * `isSettled` is a worklet; each time it turns true the settled transform reaches the shadow tree.
 */
export function useShadowTreeSyncOnSettle(
  isSettled: () => boolean,
  dependencies: readonly unknown[],
): void {
  useAnimatedReaction(
    isSettled,
    (settled, previous) => {
      if (settled && previous === false) {
        scheduleOnRN(requestShadowTreeSync);
      }
    },
    [...dependencies],
  );
}
