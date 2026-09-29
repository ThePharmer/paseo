import { describe, expect, it } from "vitest";
import { createShadowTreeSync } from "./scheduler";

function createFrameQueue() {
  let callbacks: Array<() => void> = [];
  return {
    requestFrame(callback: () => void) {
      callbacks.push(callback);
    },
    runFrame() {
      const due = callbacks;
      callbacks = [];
      for (const callback of due) callback();
    },
  };
}

function createObservedSync() {
  const frames = createFrameQueue();
  const sync = createShadowTreeSync({ requestFrame: frames.requestFrame });
  const commits: number[] = [];
  const unsubscribe = sync.subscribe(() => commits.push(sync.getRevision()));
  return { frames, sync, commits, unsubscribe };
}

describe("shadow tree sync", () => {
  it("commits on the frame after a container settles, not during the settle frame", () => {
    const { frames, sync, commits } = createObservedSync();

    sync.request();
    expect(commits).toEqual([]);
    expect(sync.getRevision()).toBe(0);

    frames.runFrame();
    expect(commits).toEqual([1]);
  });

  it("commits once for every container that settles in the same frame", () => {
    const { frames, sync, commits } = createObservedSync();

    sync.request();
    sync.request();
    sync.request();
    frames.runFrame();

    expect(commits).toEqual([1]);
  });

  it("commits again when another container settles later", () => {
    const { frames, sync, commits } = createObservedSync();

    sync.request();
    frames.runFrame();
    sync.request();
    frames.runFrame();

    expect(commits).toEqual([1, 2]);
  });

  it("stops notifying an unsubscribed anchor", () => {
    const { frames, sync, commits, unsubscribe } = createObservedSync();

    unsubscribe();
    sync.request();
    frames.runFrame();

    expect(commits).toEqual([]);
    expect(sync.getRevision()).toBe(1);
  });
});
