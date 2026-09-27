/**
 * @vitest-environment jsdom
 */
import { highlightCode, type BackgroundHighlight } from "@getpaseo/highlight";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { composeCodeHighlight, useBackgroundHighlight } from "./use-background-highlight";

function finished(code: string): BackgroundHighlight {
  return { code, lines: highlightCode(code, "x.ts"), exact: true };
}

describe("composeCodeHighlight", () => {
  it("paints everything plain before any highlight finishes", () => {
    expect(composeCodeHighlight("const a = 1;", null)).toEqual({
      lines: [],
      plainTail: "const a = 1;",
    });
  });

  it("uses every highlighted line once the highlight has caught up", () => {
    const code = "const a = 1;\nconst b = 2;";
    expect(composeCodeHighlight(code, finished(code))).toEqual({
      lines: finished(code).lines,
      plainTail: null,
    });
  });

  it("paints growth plain, including the highlight's last line", () => {
    const old = "const a = 1;\nconst b";
    const display = composeCodeHighlight(`${old} = 2;\nlet c`, finished(old));
    expect(display.lines).toEqual(finished(old).lines.slice(0, 1));
    expect(display.plainTail).toBe("const b = 2;\nlet c");
  });

  it("ignores a highlight of text that was replaced rather than extended", () => {
    expect(composeCodeHighlight("let x = 1;", finished("const a = 1;"))).toEqual({
      lines: [],
      plainTail: "let x = 1;",
    });
  });
});

describe("useBackgroundHighlight", () => {
  const code = '{ "a": 1 }';

  it("highlights settled code off the render path", async () => {
    const { result } = renderHook(() =>
      useBackgroundHighlight(code, "ts", { enabled: true, settled: true }),
    );
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.code).toBe(code));
    expect(result.current?.lines).toEqual(highlightCode(code, "x.ts"));
  });

  it("never returns another language's result after the language changes", async () => {
    // Every render's value, including the first render after the change, which is
    // the one a caller would paint and cache before any effect runs.
    const renders: Array<{ extension: string; lines: unknown }> = [];
    const { result, rerender } = renderHook(
      ({ extension }) => {
        const value = useBackgroundHighlight(code, extension, { enabled: true, settled: true });
        renders.push({ extension, lines: value?.lines ?? null });
        return value;
      },
      { initialProps: { extension: "ts" } },
    );
    await waitFor(() => expect(result.current?.code).toBe(code));
    const tsLines = highlightCode(code, "x.ts");
    const jsonLines = highlightCode(code, "x.json");
    expect(tsLines).not.toEqual(jsonLines);

    rerender({ extension: "json" });
    await waitFor(() => expect(result.current?.lines).toEqual(jsonLines));
    for (const render of renders.filter((entry) => entry.extension === "json")) {
      expect(render.lines).not.toEqual(tsLines);
    }
  });

  it("returns nothing while disabled", () => {
    const { result } = renderHook(() =>
      useBackgroundHighlight(code, "ts", { enabled: false, settled: true }),
    );
    expect(result.current).toBeNull();
  });
});
