import { describe, expect, it } from "vitest";
import { highlightCode } from "@getpaseo/highlight";
import { MAX_HIGHLIGHTED_LINE_TOKENS, buildSourceLines, type SourceLine } from "./lines";

// The data from issue #6322's reproduction steps.
const records = Array.from({ length: 900 }, (_, i) => ({
  t: `comment number ${i} with some text`,
  l: i % 7,
  r: i % 3,
  u: `user${i}`,
}));

// A JSON array line that the highlighter splits into exactly `count` tokens:
// "[", then alternating numbers and commas, then "]", plus an unstyled
// trailing space when `count` is even.
function jsonLineWithTokens(count: number): string {
  const numbers = Math.floor((count - 1) / 2);
  const line = `[${Array.from({ length: numbers }, () => "1").join(",")}]`;
  return count % 2 === 0 ? `${line} ` : line;
}

function lineTokens(line: SourceLine) {
  return line.tokens.map(({ token }) => token);
}

describe("buildSourceLines", () => {
  it("renders the minified one-line JSON from #6322 as one unstyled line", () => {
    const content = JSON.stringify(records);
    expect(new TextEncoder().encode(content).byteLength).toBe(60_981);
    expect(highlightCode(content, "one-line-repro.json").map((line) => line.length)).toEqual([
      14_401,
    ]);

    const lines = buildSourceLines({
      content,
      filename: "one-line-repro.json",
      presentation: "highlighted",
    });

    expect(lines).toEqual([
      { number: 1, tokens: [{ key: "0", token: { text: content, style: null } }] },
    ]);
  });

  it("keeps the pretty-printed control from #6322 highlighted line for line", () => {
    const content = `${JSON.stringify(records, null, 2)}\n`;
    expect(new TextEncoder().encode(content).byteLength).toBe(87_983);

    const lines = buildSourceLines({
      content,
      filename: "multi-line-control.json",
      presentation: "highlighted",
    });

    expect(lines.map(lineTokens)).toEqual(highlightCode(content, "multi-line-control.json"));
    expect(lines.map((line) => line.number)).toEqual(lines.map((_, index) => index + 1));
  });

  it("collapses only the lines over the token limit", () => {
    const atLimit = jsonLineWithTokens(MAX_HIGHLIGHTED_LINE_TOKENS);
    const overLimit = jsonLineWithTokens(MAX_HIGHLIGHTED_LINE_TOKENS + 1);
    const content = [atLimit, overLimit, "[1]"].join("\n");
    const highlighted = highlightCode(content, "data.json");
    expect(highlighted.map((line) => line.length)).toEqual([
      MAX_HIGHLIGHTED_LINE_TOKENS,
      MAX_HIGHLIGHTED_LINE_TOKENS + 1,
      3,
    ]);

    const lines = buildSourceLines({ content, filename: "data.json", presentation: "highlighted" });

    expect(lines.map(lineTokens)).toEqual([
      highlighted[0],
      [{ text: overLimit, style: null }],
      highlighted[2],
    ]);
    expect(lines.map((line) => line.number)).toEqual([1, 2, 3]);
  });

  it("keys tokens by position so repeated tokens stay distinct", () => {
    const lines = buildSourceLines({
      content: "[1,1,1]",
      filename: "data.json",
      presentation: "highlighted",
    });

    expect(lines[0].tokens.map(({ key }) => key)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
  });

  it("renders the plain tier as one unstyled token per line", () => {
    const lines = buildSourceLines({
      content: "first\nsecond",
      filename: "data.json",
      presentation: "plain",
    });

    expect(lines).toEqual([
      { number: 1, tokens: [{ key: "0", token: { text: "first", style: null } }] },
      { number: 2, tokens: [{ key: "0", token: { text: "second", style: null } }] },
    ]);
  });
});
