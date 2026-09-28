/**
 * A fenced code block that is open at some point in a Markdown text. Paragraph
 * delivery carries it across releases so a later scan knows whether its first
 * line is still inside code.
 */
export interface MarkdownFence {
  marker: "`" | "~";
  length: number;
  indent: number;
  /** Blockquote markers before the opener. Its closer sits at the same depth. */
  quoteDepth: number;
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

// A fence may open after container markers: blockquote `>` markers and
// list-item markers (`-`, `*`, `+`, `1.`, `1)`), as in "- ```ts" or "> ~~~".
// Its indent is the column where the run starts, so a closer indented to the
// list item's content column matches it. A closer only strips the blockquote
// depth its opener had, never list markers: inside a code block, "- ```" is
// code. The scanner does not track container nesting, so it can read a
// four-space indented line as a fence; that only holds text longer, which the
// size cap bounds, whereas missing a real fence would release a code block
// that is still growing. A closer may be indented at most three columns past
// its opener. Parsing is a single cursor pass: a backtracking regex over
// repeated prefixes is exponential on lines like "> > > ... x".
interface FenceLine {
  marker: "`" | "~";
  length: number;
  indent: number;
  quoteDepth: number;
  info: string;
}

function skipSpaces(line: string, from: number): number {
  let cursor = from;
  while (line[cursor] === " ") {
    cursor += 1;
  }
  return cursor;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function skipListMarker(line: string, from: number): number {
  const char = line[from];
  let cursor = from;
  if (char === "-" || char === "*" || char === "+") {
    cursor += 1;
  } else {
    while (cursor - from < 9 && isDigit(line.charCodeAt(cursor))) {
      cursor += 1;
    }
    if (cursor === from || (line[cursor] !== "." && line[cursor] !== ")")) {
      return from;
    }
    cursor += 1;
  }
  return line[cursor] === " " ? skipSpaces(line, cursor) : from;
}

function parseFenceLine(line: string, container: { quoteDepth: number } | null): FenceLine | null {
  let cursor = skipSpaces(line, 0);
  let quoteDepth = 0;
  if (container === null) {
    // Opener: any mix of blockquote and list-item markers.
    for (;;) {
      if (line[cursor] === ">") {
        quoteDepth += 1;
        cursor = skipSpaces(line, cursor + 1);
        continue;
      }
      const afterMarker = skipListMarker(line, cursor);
      if (afterMarker === cursor) {
        break;
      }
      cursor = afterMarker;
    }
  } else {
    // Closer: exactly the opener's blockquote depth, then spaces.
    while (quoteDepth < container.quoteDepth && line[cursor] === ">") {
      quoteDepth += 1;
      cursor = skipSpaces(line, cursor + 1);
    }
    if (quoteDepth !== container.quoteDepth) {
      return null;
    }
  }
  const marker = line[cursor];
  if (marker !== "`" && marker !== "~") {
    return null;
  }
  const indent = cursor;
  while (line[cursor] === marker) {
    cursor += 1;
  }
  const length = cursor - indent;
  if (length < 3) {
    return null;
  }
  return { marker, length, indent, quoteDepth, info: line.slice(cursor) };
}

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
    const fenceLine = parseFenceLine(line, fence);

    if (fenceLine) {
      if (fence === null) {
        fence = {
          marker: fenceLine.marker,
          length: fenceLine.length,
          indent: fenceLine.indent,
          quoteDepth: fenceLine.quoteDepth,
        };
      } else if (
        fenceLine.marker === fence.marker &&
        fenceLine.length >= fence.length &&
        fenceLine.indent <= fence.indent + 3 &&
        fenceLine.info === ""
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
