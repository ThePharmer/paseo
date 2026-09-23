import { describe, expect, it } from "vitest";
import { encodeFrames, FrameAssembler, FRAME_DATA_LENGTH } from "./frames";

function roundTrip(message: unknown, dataLength?: number): unknown[] {
  const assembler = new FrameAssembler();
  return encodeFrames({ message, id: 1, dataLength })
    .map((frame) => assembler.receive(frame))
    .filter((value) => value !== undefined);
}

describe("editor bridge frames", () => {
  it("sends a small message as one frame", () => {
    const frames = encodeFrames({ message: { type: "cursor", line: 3, column: 7 }, id: 4 });
    expect(frames).toHaveLength(1);
    expect(roundTrip({ type: "cursor", line: 3, column: 7 })).toEqual([
      { type: "cursor", line: 3, column: 7 },
    ]);
  });

  it("splits a large document into bounded frames and reassembles it", () => {
    const content = "const value = 1;\n".repeat(20_000);
    const message = { type: "edit", revision: 2, content };
    const frames = encodeFrames({ message, id: 9 });
    expect(frames.length).toBeGreaterThan(4);
    for (const frame of frames) {
      expect(frame.length).toBeLessThan(FRAME_DATA_LENGTH * 2 + 100);
    }
    expect(roundTrip(message)).toEqual([message]);
  });

  it("never splits a surrogate pair across frames", () => {
    const message = { content: "😀".repeat(50) };
    const frames = encodeFrames({ message, id: 1, dataLength: 7 });
    for (const frame of frames) {
      const { data } = JSON.parse(frame) as { data: string };
      expect(data).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(data).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(roundTrip(message, 7)).toEqual([message]);
  });

  it("drops a partial message when a new message starts before it completes", () => {
    const assembler = new FrameAssembler();
    const first = encodeFrames({ message: { content: "a".repeat(40) }, id: 1, dataLength: 10 });
    const second = encodeFrames({ message: { content: "b" }, id: 2, dataLength: 10 });
    expect(assembler.receive(first[0])).toBeUndefined();
    expect(assembler.receive(second[0])).toBeUndefined();
    const received = second.slice(1).map((frame) => assembler.receive(frame));
    expect(received.at(-1)).toEqual({ content: "b" });
    expect(assembler.receive(first[1])).toBeUndefined();
  });

  it("drops a message whose frames arrive out of order", () => {
    const assembler = new FrameAssembler();
    const frames = encodeFrames({ message: { content: "x".repeat(30) }, id: 3, dataLength: 10 });
    expect(assembler.receive(frames[0])).toBeUndefined();
    expect(assembler.receive(frames[2])).toBeUndefined();
    expect(assembler.receive(frames[1])).toBeUndefined();
    expect(frames).toHaveLength(5);
    expect(frames.slice(3).map((frame) => assembler.receive(frame))).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("ignores malformed frames", () => {
    const assembler = new FrameAssembler();
    expect(assembler.receive("not json")).toBeUndefined();
    expect(assembler.receive(JSON.stringify({ id: 1, index: 0, count: 0, data: "{}" }))).toBe(
      undefined,
    );
    expect(assembler.receive(JSON.stringify({ id: 1, index: 0, count: 1, data: "{" }))).toBe(
      undefined,
    );
    expect(assembler.receive(JSON.stringify({ type: "cursor" }))).toBeUndefined();
  });
});
