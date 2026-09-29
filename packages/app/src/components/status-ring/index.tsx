import { memo } from "react";
import { Animated, View } from "react-native";
import { StatusRingFrame, type StatusRingProps, styles } from "@/components/status-ring/frame";
import { useStatusRingRotatorStyle } from "@/components/status-ring/clock";

/**
 * Native running indicator. React Native's native animated driver turns every ring from one shared
 * value, so a ring that mounts mid-flight is already in phase. See `clock.ts`.
 *
 * The rotated view carries no theme-tracked style; the coloured arc is nested inside it, so
 * Unistyles and the animation driver never write to the same native view (docs/unistyles.md).
 */
export const StatusRing = memo(function StatusRing({ backdrop }: StatusRingProps) {
  const rotatorStyle = useStatusRingRotatorStyle();

  return (
    <StatusRingFrame backdrop={backdrop}>
      <Animated.View style={rotatorStyle}>
        <View style={styles.arc} />
      </Animated.View>
    </StatusRingFrame>
  );
});
