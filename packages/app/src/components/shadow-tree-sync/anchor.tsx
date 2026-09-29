// Only Android applies animated transforms without shadow-tree commits
// (ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS), so other platforms have nothing to sync.
export function ShadowTreeSyncAnchor() {
  return null;
}
