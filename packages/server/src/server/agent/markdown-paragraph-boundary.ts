/**
 * A fenced code block that is open at some point in a Markdown text. Paragraph
 * delivery carries it across releases so a later scan knows whether its first
 * line is still inside code.
 */
export interface MarkdownFence {
  marker: "`" | "~";
  length: number;
  indent: number;
}

export interface MarkdownParagraphBoundary {
  /**
   * End of the last finished paragraph or closed code block, or -1 when the
   * text has none yet. Everything before it keeps its Markdown shape no matter
   * what arrives next.
   */
  boundary: number;
  /** End of the last complete line (just past its newline), or 0 when there is none. */
  lastLineEnd: number;
  /** The fence still open at `lastLineEnd`. */
  openFenceAtLastLineEnd: MarkdownFence | null;
}

// An opening fence may sit at any indentation, since fences inside list items
// are indented past the marker. A closing fence may be indented at most three
// spaces more than its opener; deeper lines are content in the block.
const FENCE_PATTERN = /^( *)(`{3,}|~{3,})(.*)$/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as a
// no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;

/**
 * Scans complete lines only, so a trailing partial line never counts: a
 * half-written fence marker or a line still waiting for its newline cannot
 * create a boundary. A blank line counts outside a fence unless it is the first
 * line, which only separates the text from something already delivered.
 */
export function findMarkdownParagraphBoundary(
  text: string,
  openFence: MarkdownFence | null,
): MarkdownParagraphBoundary {
  let fence = openFence;
  let boundary = -1;
  let lineStart = 0;

  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) {
      break;
    }
    const line = text.slice(lineStart, newline).replace(/[ \t\r]+$/, "");
    const lineEnd = newline + 1;
    const fenceMatch = FENCE_PATTERN.exec(line);

    if (fenceMatch) {
      const indent = fenceMatch[1]?.length ?? 0;
      const run = fenceMatch[2] ?? "";
      const info = fenceMatch[3] ?? "";
      const marker = run[0] === "~" ? "~" : "`";
      if (fence === null) {
        fence = { marker, length: run.length, indent };
      } else if (
        marker === fence.marker &&
        run.length >= fence.length &&
        indent <= fence.indent + 3 &&
        info === ""
      ) {
        // CommonMark: a closing fence carries no info string.
        fence = null;
        boundary = lineEnd;
      }
    } else if (fence === null && lineStart > 0 && BLANK_LINE_PATTERN.test(line)) {
      boundary = lineEnd;
    }

    lineStart = lineEnd;
  }

  return { boundary, lastLineEnd: lineStart, openFenceAtLastLineEnd: fence };
}
