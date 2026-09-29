import { useMemo } from "react";
import { Animated, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { createNativeLoop, useNativeLoop } from "@/components/native-loop";
import {
  SYNCED_LOADER_DOT_COUNT,
  SYNCED_LOADER_DURATION_MS,
  getSyncedLoaderDotInterpolation,
  getSyncedLoaderDotOpacity,
  getSyncedLoaderGrid,
} from "@/components/synced-loader-state";

const GRID_COLUMNS = 2;
const DOT_KEYS = Array.from({ length: SYNCED_LOADER_DOT_COUNT }, (_, i) => `dot-${i}`);

// Every loader on screen follows one native-driven loop started at the wall-clock phase, so they
// step together. The progress counts steps; each dot maps it to its opacity for the current step.
const loaderLoop = createNativeLoop({
  periodMs: SYNCED_LOADER_DURATION_MS,
  span: SYNCED_LOADER_DOT_COUNT,
});
const loaderStep = Animated.modulo(loaderLoop.progress, SYNCED_LOADER_DOT_COUNT);
const steppingOpacities = DOT_KEYS.map((_, dot) =>
  loaderStep.interpolate({ ...getSyncedLoaderDotInterpolation(dot), extrapolate: "clamp" }),
);
const restingOpacities = DOT_KEYS.map((_, dot) => getSyncedLoaderDotOpacity(0, dot));

export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  const panelActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const reduceMotion = useReducedMotion();
  // Hidden loaders stay mounted with static opacities, detached from the shared value.
  const isStepping = panelActive && appVisible && !reduceMotion;
  useNativeLoop(loaderLoop.loop, isStepping);
  const opacities = isStepping ? steppingOpacities : restingOpacities;

  const { gap, dotSize, gridWidth, gridHeight } = getSyncedLoaderGrid(size);
  const gridStyle = useMemo(
    () => ({ width: gridWidth, height: gridHeight }),
    [gridHeight, gridWidth],
  );
  const containerStyle = useMemo(
    () =>
      ({
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }) as const,
    [size],
  );

  return (
    <View style={containerStyle}>
      <View style={gridStyle}>
        {DOT_KEYS.map((key, dotIndex) => {
          const rowIndex = Math.floor(dotIndex / GRID_COLUMNS);
          const columnIndex = dotIndex % GRID_COLUMNS;

          return (
            <SpinnerDot
              key={key}
              color={color}
              dotSize={dotSize}
              opacity={opacities[dotIndex]}
              left={columnIndex * (dotSize + gap)}
              top={rowIndex * (dotSize + gap)}
            />
          );
        })}
      </View>
    </View>
  );
}

function SpinnerDot({
  color,
  dotSize,
  opacity,
  left,
  top,
}: {
  color: string;
  dotSize: number;
  opacity: Animated.AnimatedInterpolation<number> | number;
  left: number;
  top: number;
}) {
  const dotStyle = useMemo(
    () => ({
      opacity,
      width: dotSize,
      height: dotSize,
      borderRadius: dotSize / 2,
      backgroundColor: color,
      position: "absolute" as const,
      left,
      top,
    }),
    [opacity, dotSize, color, left, top],
  );

  return <Animated.View style={dotStyle} />;
}
