import { describe, expect, it } from "vitest";
import { BackgroundHighlighter, createBackgroundHighlighter } from "../background.js";
import { highlightCode } from "../highlighter.js";

const typescript = [
  "/* a comment",
  "   spanning lines */",
  "export function greet(name: string): string {",
  "  const template = `hello ${name}`;",
  "",
  "  return template.replace(/l+/g, 'L'); // trailing",
  "}",
  "",
].join("\n");

function highlighterFor(filename: string): BackgroundHighlighter {
  const highlighter = createBackgroundHighlighter(filename);
  if (!highlighter) throw new Error(`no grammar for ${filename}`);
  return highlighter;
}

/** Drive the highlighter to completion, yielding after every step. */
function highlightInSteps(highlighter: BackgroundHighlighter, code: string) {
  let steps = 0;
  while (!highlighter.isCaughtUp(code)) {
    highlighter.work(code, () => true);
    steps += 1;
    if (steps > 100_000) throw new Error("highlighter did not finish");
  }
  return { result: highlighter.latest!, steps };
}

describe("BackgroundHighlighter", () => {
  it.each([
    { filename: "x.ts", code: typescript },
    { filename: "x.py", code: 'def hello():\n    """doc\n    string"""\n    print("world")\n' },
    { filename: "x.swift", code: 'struct Greeter {\n    let message = "hello"\n}' },
    { filename: "x.ts", code: "" },
  ])("matches a one-shot highlight of $filename when done in small steps", ({ filename, code }) => {
    const { result } = highlightInSteps(highlighterFor(filename), code);
    expect(result.code).toBe(code);
    expect(result.lines).toEqual(highlightCode(code, filename));
  });

  it("tokenizes a long document across several steps to the same lines", () => {
    const code = Array.from(
      { length: 400 },
      (_, index) => `const value${index} = "${index}";`,
    ).join("\n");
    const { result, steps } = highlightInSteps(highlighterFor("x.ts"), code);
    expect(steps).toBeGreaterThan(10);
    expect(result.lines).toEqual(highlightCode(code, "x.ts"));
  });

  it("follows appended text and keeps unchanged lines' identity", () => {
    const highlighter = highlighterFor("x.ts");
    let previous = null as ReturnType<typeof highlightInSteps>["result"] | null;
    for (let length = 10; length <= typescript.length; length += 7) {
      const code = typescript.slice(0, length);
      const { result } = highlightInSteps(highlighter, code);
      expect(result.lines).toEqual(highlightCode(code, "x.ts"));
      if (previous) {
        // Every line before the previous last line was complete and is unchanged.
        for (let index = 0; index < previous.lines.length - 1; index += 1) {
          if (JSON.stringify(previous.lines[index]) === JSON.stringify(result.lines[index])) {
            expect(result.lines[index]).toBe(previous.lines[index]);
          }
        }
      }
      previous = result;
    }
  });

  it("finishes the snapshot it started before moving to newer text", () => {
    const highlighter = highlighterFor("x.ts");
    const first = typescript.slice(0, 60);
    highlighter.work(first, () => true);
    expect(highlighter.isCaughtUp(first)).toBe(false);

    const seen: string[] = [];
    while (!highlighter.isCaughtUp(typescript)) {
      const latest = highlighter.work(typescript, () => true);
      if (latest && seen[seen.length - 1] !== latest.code) seen.push(latest.code);
    }
    expect(seen).toEqual([first, typescript]);
  });

  it("splits one long line across steps and still matches a one-shot highlight", () => {
    const entries = Array.from({ length: 1_500 }, (_, index) => `"key${index}": [${index}, true]`);
    const code = `const payload = { ${entries.join(", ")} };`;
    const { result, steps } = highlightInSteps(highlighterFor("x.ts"), code);
    expect(code).not.toContain("\n");
    expect(steps).toBeGreaterThan(code.length / 2_000);
    expect(result.lines).toEqual(highlightCode(code, "x.ts"));
  });

  it("matches a one-shot highlight when newlines fall on step boundaries", () => {
    for (const offset of [-2, -1, 0, 1]) {
      const firstLine = `const a = "${"x".repeat(2_000 + offset - 13)}";`;
      const code = `${firstLine}\n\nlet b = 1;\n`;
      const { result } = highlightInSteps(highlighterFor("x.ts"), code);
      expect(result.lines, `offset ${offset}`).toEqual(highlightCode(code, "x.ts"));
    }
  });

  it("tokenizes every line again once asked for an exact result", () => {
    const highlighter = highlighterFor("x.ts");
    const lines = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`);
    const half = lines.slice(0, 20).join("\n");
    const whole = lines.join("\n");
    highlightInSteps(highlighter, half);
    highlightInSteps(highlighter, whole);
    expect(highlighter.isCaughtUp(whole)).toBe(true);
    expect(highlighter.isCaughtUp(whole, true)).toBe(false);

    while (!highlighter.isCaughtUp(whole, true)) {
      highlighter.work(whole, () => true, { exact: true });
    }
    expect(highlighter.latest!.lines).toEqual(highlightCode(whole, "x.ts"));
  });

  it("parses replaced text from scratch", () => {
    const highlighter = highlighterFor("x.ts");
    highlightInSteps(highlighter, typescript);
    const replaced = "let changed = true;\n" + typescript.slice(20);
    const { result } = highlightInSteps(highlighter, replaced);
    expect(result.lines).toEqual(highlightCode(replaced, "x.ts"));
  });

  it("does all the work in one call when never asked to yield", () => {
    const highlighter = highlighterFor("x.ts");
    const result = highlighter.work(typescript, () => false);
    expect(result?.code).toBe(typescript);
    expect(highlighter.isCaughtUp(typescript)).toBe(true);
  });

  it("has no highlighter for a file without a grammar", () => {
    expect(createBackgroundHighlighter("notes.unknown-extension")).toBeNull();
  });
});
