import type { Tree } from "@lezer/common";
import { highlightTree } from "@lezer/highlight";
import type { HighlightStyle, HighlightToken } from "./types.js";
import { getParserForFile } from "./parsers.js";

import { staticSyntaxHighlighter } from "./syntax-roles.js";

export function highlightCode(code: string, filename: string): HighlightToken[][] {
  const parser = getParserForFile(filename);

  if (!parser) {
    return code.split("\n").map((line) => [{ text: line, style: null }]);
  }

  return highlightTreeLines(code, parser.parse(code), 0, code.length);
}

/**
 * Tokens for `code` between `from` and `to`, one list per line, read from a parse of
 * the whole of `code`. A range that starts or ends partway through a line gives that
 * line's part, so a caller can tokenize a long document a piece at a time.
 */
export function highlightTreeLines(
  code: string,
  tree: Tree,
  from: number,
  to: number,
): HighlightToken[][] {
  const lines = code.slice(from, to).split("\n");
  const result: HighlightToken[][] = [];

  for (let i = 0; i < lines.length; i++) {
    result.push([]);
  }

  // Build a map of character positions to styles
  const styleMap: Array<HighlightStyle | null> = Array.from({ length: to - from }, () => null);

  highlightTree(
    tree,
    staticSyntaxHighlighter,
    (start, end, classes) => {
      for (let i = Math.max(start, from); i < end && i < to; i++) {
        styleMap[i - from] = classes as HighlightStyle;
      }
    },
    from,
    to,
  );

  // Convert style map to tokens per line
  let pos = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    if (line.length === 0) {
      result[lineIndex].push({ text: "", style: null });
      pos++; // skip newline
      continue;
    }

    let currentToken: HighlightToken = { text: "", style: styleMap[pos] };

    for (let i = 0; i < line.length; i++) {
      const charStyle = styleMap[pos + i];
      if (charStyle === currentToken.style) {
        currentToken.text += line[i];
      } else {
        if (currentToken.text) {
          result[lineIndex].push(currentToken);
        }
        currentToken = { text: line[i], style: charStyle };
      }
    }

    if (currentToken.text) {
      result[lineIndex].push(currentToken);
    }

    pos += line.length + 1; // +1 for newline
  }

  return result;
}

export function highlightLine(line: string, filename: string): HighlightToken[] {
  const result = highlightCode(line, filename);
  return result[0] ?? [{ text: line, style: null }];
}
