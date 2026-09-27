/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { View } from "react-native";
import { afterEach, describe, expect, it } from "vitest";
import { useHeldWhileSelected } from "./use-held-while-selected.web";

function mountText(text: string): HTMLElement {
  const container = document.createElement("div");
  container.textContent = text;
  document.body.appendChild(container);
  return container;
}

function select(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function clearSelection() {
  act(() => {
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
}

describe("useHeldWhileSelected", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  function render(container: HTMLElement, enabled = true) {
    const ref = { current: container as unknown as View };
    return renderHook(({ value }) => useHeldWhileSelected(value, ref, enabled), {
      initialProps: { value: "plain" },
    });
  }

  it("keeps the old value while a selection is inside the container", () => {
    const container = mountText("const answer = 42;");
    const { result, rerender } = render(container);
    select(container.firstChild!, 0, 12);

    rerender({ value: "highlighted" });
    expect(result.current).toBe("plain");

    clearSelection();
    expect(result.current).toBe("highlighted");
  });

  it("takes new values while the selection is elsewhere", () => {
    const container = mountText("const answer = 42;");
    const elsewhere = mountText("unrelated text");
    const { result, rerender } = render(container);
    select(elsewhere.firstChild!, 0, 9);

    rerender({ value: "highlighted" });
    expect(result.current).toBe("highlighted");
  });

  it("does not hold when disabled", () => {
    const container = mountText("const answer = 42;");
    const { result, rerender } = render(container, false);
    select(container.firstChild!, 0, 12);

    rerender({ value: "highlighted" });
    expect(result.current).toBe("highlighted");
  });
});
