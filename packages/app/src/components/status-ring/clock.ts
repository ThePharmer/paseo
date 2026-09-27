import { useLayoutEffect, useState } from "react";
import { makeMutable, type SharedValue, useSharedValue } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  advanceStatusRingClock,
  hideStatusRing,
  IDLE_STATUS_RING_CLOCK,
  showStatusRing,
} from "@/components/status-ring/clock-state";
import { getStatusRingRotation } from "@/components/status-ring/geometry";
import { useAppVisible } from "@/hooks/use-app-visible";

const sharedRotation = makeMutable(getStatusRingRotation(Date.now()));
const clock = makeMutable(IDLE_STATUS_RING_CLOCK);
let nextRotationListenerId = 1;

function advanceSharedRotation(frameTimestampMs: number): void {
  "worklet";
  const frame = advanceStatusRingClock(clock.value, frameTimestampMs);
  clock.value = frame.clock;
  if (frame.action === "stop") {
    return;
  }

  if (frame.action === "publish") {
    sharedRotation.value = getStatusRingRotation(Date.now());
  }
  requestAnimationFrame(advanceSharedRotation);
}

function showRing(
  rotation: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (registered.value) {
    return;
  }

  registered.value = true;
  const shown = showStatusRing(clock.value);
  clock.value = shown.clock;
  if (shown.startLoop) {
    sharedRotation.value = getStatusRingRotation(Date.now());
    requestAnimationFrame(advanceSharedRotation);
  }

  rotation.value = sharedRotation.value;
  sharedRotation.addListener(listenerId, (nextRotation) => {
    rotation.value = nextRotation;
  });
}

function hideRing(registered: SharedValue<boolean>, listenerId: number): void {
  "worklet";
  if (!registered.value) {
    return;
  }

  registered.value = false;
  sharedRotation.removeListener(listenerId);
  clock.value = hideStatusRing(clock.value);
}

/**
 * The rotation for one native ring. Every ring on screen copies the same UI-thread value, so they
 * stay in phase; a ring off screen (its retained panel inactive, or the app not in the foreground)
 * stays mounted but detaches, and the clock's frame loop ends once no ring is on screen.
 */
export function useStatusRingRotation(): SharedValue<number> {
  const panelActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const onScreen = panelActive && appVisible;
  const rotation = useSharedValue(getStatusRingRotation(Date.now()));
  const registered = useSharedValue(false);
  const [listenerId] = useState(() => nextRotationListenerId++);

  useLayoutEffect(() => {
    if (!onScreen) {
      return;
    }

    scheduleOnUI(showRing, rotation, registered, listenerId);
    return () => {
      scheduleOnUI(hideRing, registered, listenerId);
    };
  }, [listenerId, onScreen, registered, rotation]);

  return rotation;
}
