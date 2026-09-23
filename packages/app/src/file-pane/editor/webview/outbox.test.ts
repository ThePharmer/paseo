import { describe, expect, it } from "vitest";
import { ManualClock } from "@/test/manual-clock";
import { EditOutbox } from "./outbox";

function makeOutbox() {
  const clock = new ManualClock();
  const sent: number[] = [];
  let document = 0;
  const outbox = new EditOutbox({
    clock,
    intervalMs: 300,
    send: () => sent.push(document),
  });
  function type() {
    document += 1;
    outbox.change();
  }
  return { clock, sent, outbox, type };
}

describe("EditOutbox", () => {
  it("sends the first change after a quiet period immediately", () => {
    const { sent, type } = makeOutbox();
    type();
    expect(sent).toEqual([1]);
  });

  it("sends continuous typing at most once per interval, ending with the latest document", () => {
    const { clock, sent, type } = makeOutbox();
    type();
    clock.advance(100);
    type();
    clock.advance(100);
    type();
    expect(sent).toEqual([1]);
    clock.advance(100);
    expect(sent).toEqual([1, 3]);
    clock.advance(300);
    expect(sent).toEqual([1, 3]);
    type();
    expect(sent).toEqual([1, 3, 4]);
  });

  it("flushes pending changes immediately and only once", () => {
    const { clock, sent, outbox, type } = makeOutbox();
    type();
    type();
    type();
    outbox.flush();
    expect(sent).toEqual([1, 3]);
    outbox.flush();
    clock.advance(1_000);
    expect(sent).toEqual([1, 3]);
  });

  it("does not send when flushed with nothing pending", () => {
    const { sent, outbox, type } = makeOutbox();
    outbox.flush();
    expect(sent).toEqual([]);
    type();
    outbox.flush();
    expect(sent).toEqual([1]);
  });

  it("drops unsent changes when the app replaces the document", () => {
    const { clock, sent, outbox, type } = makeOutbox();
    type();
    type();
    outbox.discard();
    clock.advance(1_000);
    expect(sent).toEqual([1]);
    expect(clock.pendingTimers).toBe(0);
    type();
    expect(sent).toEqual([1, 3]);
  });
});
