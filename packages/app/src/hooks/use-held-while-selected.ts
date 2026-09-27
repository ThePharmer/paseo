import type { RefObject } from "react";
import type { View } from "react-native";

/**
 * Web holds a value while a selection is inside the container (see the `.web.ts`
 * file). Native text selection is scoped to one Text and is not observable here.
 */
export function useHeldWhileSelected<T>(
  value: T,
  _containerRef: RefObject<View | null>,
  _enabled: boolean,
): T {
  return value;
}
