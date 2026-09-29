import { useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import { shadowTreeSync } from "./index";

// React only commits to Fabric when a host prop changes, so each sync renders a new nativeID on
// this empty view. The commit it produces is what makes Reanimated apply its registry.
export function ShadowTreeSyncAnchor() {
  const revision = useSyncExternalStore(shadowTreeSync.subscribe, shadowTreeSync.getRevision);
  return (
    <View
      importantForAccessibility="no"
      nativeID={`shadow-tree-sync-${revision}`}
      pointerEvents="none"
      style={styles.anchor}
    />
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: "absolute",
    width: 0,
    height: 0,
  },
});
