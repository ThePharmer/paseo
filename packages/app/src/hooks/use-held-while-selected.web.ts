import { useState, useSyncExternalStore, type RefObject } from "react";
import type { View } from "react-native";

function subscribeToSelection(onChange: () => void): () => void {
  document.addEventListener("selectionchange", onChange);
  return () => document.removeEventListener("selectionchange", onChange);
}

function subscribeToNothing(): () => void {
  return () => {};
}

function hasSelectionInside(node: unknown): boolean {
  if (!(node instanceof Node)) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return node.contains(selection.anchorNode) || node.contains(selection.focusNode);
}

/**
 * Keep returning the value from before a selection started inside the container for
 * as long as the selection lasts. Re-rendering replaces the text nodes the selection
 * is anchored in, which collapses it and leaves nothing to copy.
 */
export function useHeldWhileSelected<T>(
  value: T,
  containerRef: RefObject<View | null>,
  enabled: boolean,
): T {
  const selected = useSyncExternalStore(
    enabled ? subscribeToSelection : subscribeToNothing,
    () => enabled && hasSelectionInside(containerRef.current),
    () => false,
  );
  const [held, setHeld] = useState(value);
  if (!selected && held !== value) setHeld(value);
  return selected ? held : value;
}
