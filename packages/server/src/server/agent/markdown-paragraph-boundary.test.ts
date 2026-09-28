import { describe, expect, test } from "vitest";
import { findMarkdownParagraphBoundary } from "./markdown-paragraph-boundary.js";

// The scanner runs on every complete line of held assistant text, synchronously on the
// daemon's event loop, so a quadratic or exponential path blocks every agent and client.
describe("findMarkdownParagraphBoundary scan cost", () => {
  function scanMs(text: string): number {
    const started = performance.now();
    findMarkdownParagraphBoundary(text, null);
    return performance.now() - started;
  }

  test("scans a line of many blockquote markers in linear time", () => {
    expect(scanMs(`${"> ".repeat(50_000)}x\n`)).toBeLessThan(200);
  });

  test("trims a long whitespace run before a character in linear time", () => {
    expect(scanMs(`${" ".repeat(50_000)}x\n`)).toBeLessThan(200);
  });

  test("scans a long run of list markers in linear time", () => {
    expect(scanMs(`${"- 1. ".repeat(20_000)}x\n`)).toBeLessThan(200);
  });
});
