// With ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS, Reanimated writes transforms straight to native views
// and keeps them in its props registry without committing the shadow tree. Its commit hook applies
// that whole registry on every React commit, so one React commit after an animation settles puts
// every settled transform into the shadow tree. Pressability measures press regions from the shadow
// tree, so until that commit a press with finger movement inside a moved container is cancelled.
//
// Requests wait for the next frame: the settle callback runs on the UI thread before Reanimated
// flushes that frame's final values into the registry, and a frame also coalesces containers that
// settle together into one commit.

export interface ShadowTreeSync {
  request(): void;
  subscribe(listener: () => void): () => void;
  getRevision(): number;
}

interface ShadowTreeSyncPorts {
  requestFrame(callback: () => void): void;
}

export function createShadowTreeSync({ requestFrame }: ShadowTreeSyncPorts): ShadowTreeSync {
  let revision = 0;
  let isPending = false;
  const listeners = new Set<() => void>();

  function commit() {
    isPending = false;
    revision += 1;
    for (const listener of listeners) listener();
  }

  return {
    request() {
      if (isPending) return;
      isPending = true;
      requestFrame(commit);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getRevision() {
      return revision;
    },
  };
}
