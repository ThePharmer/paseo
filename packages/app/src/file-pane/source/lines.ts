import { highlightCode, type HighlightToken } from "@getpaseo/highlight";
import type { KeyedToken } from "@/utils/highlight-cache";

// Each line renders as one <Text> with a nested <Text> per token. On Android,
// React Native 0.81.5 creates about five spans per nested token and warns
// "Text tree size exceeded the limit" past 255 spans, around the 52nd token.
// Opening a 14,401-token minified JSON line logged tens of thousands of those
// warnings, each arriving more slowly than the last, before an ANR (#6322).
// That suggests, but does not prove, that one line's cost grows faster than
// its token count. Lines over this limit render as plain text instead.
// Hand-written code stays far below it.
export const MAX_HIGHLIGHTED_LINE_TOKENS = 128;

export interface SourceLine {
  number: number;
  tokens: KeyedToken[];
}

export function buildSourceLines(input: {
  content: string;
  filename: string;
  presentation: "highlighted" | "plain";
}): SourceLine[] {
  if (input.presentation === "highlighted")
    return highlightCode(input.content, input.filename).map((tokens, index) =>
      toSourceLine(boundLineTokens(tokens), index),
    );
  return input.content
    .split("\n")
    .map((text, index) => toSourceLine([{ text, style: null }], index));
}

function boundLineTokens(tokens: HighlightToken[]): HighlightToken[] {
  if (tokens.length <= MAX_HIGHLIGHTED_LINE_TOKENS) return tokens;
  return [{ text: tokens.map((token) => token.text).join(""), style: null }];
}

function toSourceLine(tokens: HighlightToken[], index: number): SourceLine {
  return {
    number: index + 1,
    tokens: tokens.map((token, tokenIndex) => ({ key: String(tokenIndex), token })),
  };
}
