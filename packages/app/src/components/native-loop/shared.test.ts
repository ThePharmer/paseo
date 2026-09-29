import { describe, expect, it } from "vitest";
import { createSharedLoop } from "./shared";

function createRecordingDriver() {
  const events: string[] = [];
  return {
    events,
    driver: {
      start(phase: number) {
        events.push(`start ${phase}`);
      },
      stop() {
        events.push("stop");
      },
    },
  };
}

function createLoopAt(nowMs: { value: number }) {
  const recording = createRecordingDriver();
  const loop = createSharedLoop({
    driver: recording.driver,
    now: () => nowMs.value,
    periodMs: 1000,
  });
  return { loop, events: recording.events };
}

describe("shared native loop", () => {
  it("starts at the wall-clock phase when the first consumer appears", () => {
    const { loop, events } = createLoopAt({ value: 12_250 });

    loop.retain();

    expect(events).toEqual(["start 0.25"]);
  });

  it("runs one loop for every consumer on screen", () => {
    const { loop, events } = createLoopAt({ value: 0 });

    const releaseFirst = loop.retain();
    const releaseSecond = loop.retain();
    releaseFirst();

    expect(events).toEqual(["start 0"]);

    releaseSecond();
    expect(events).toEqual(["start 0", "stop"]);
  });

  it("restarts at the current wall-clock phase after every consumer left", () => {
    const nowMs = { value: 500 };
    const { loop, events } = createLoopAt(nowMs);

    loop.retain()();
    nowMs.value = 2_750;
    loop.retain();

    expect(events).toEqual(["start 0.5", "stop", "start 0.75"]);
  });

  it("ignores a consumer releasing twice", () => {
    const { loop, events } = createLoopAt({ value: 0 });

    const releaseFirst = loop.retain();
    loop.retain();
    releaseFirst();
    releaseFirst();

    expect(events).toEqual(["start 0"]);
  });
});
