import { useAppVisible } from "@/hooks/use-app-visible";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { createNativeLoop, useNativeLoop } from "@/components/native-loop";
import { rotatorStyles } from "@/components/status-ring/frame";
import { STATUS_RING_PERIOD_MS } from "@/components/status-ring/geometry";

const ringLoop = createNativeLoop({ periodMs: STATUS_RING_PERIOD_MS, span: 1 });
const turningRotatorStyle = [
  rotatorStyles.rotator,
  {
    transform: [
      {
        rotate: ringLoop.progress.interpolate({
          inputRange: [0, 1],
          outputRange: ["0deg", "360deg"],
        }),
      },
    ],
  },
];

/**
 * The rotator style for one native ring. Every ring on screen follows the same native-driven value,
 * so they stay in phase. A ring off screen (its retained panel inactive, or the app not visible)
 * stays mounted with a static style, detached from the value, and the loop stops once no ring is
 * on screen.
 */
export function useStatusRingRotatorStyle() {
  const panelActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const onScreen = panelActive && appVisible;
  useNativeLoop(ringLoop.loop, onScreen);
  return onScreen ? turningRotatorStyle : rotatorStyles.rotator;
}
