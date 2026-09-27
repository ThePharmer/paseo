import { isExtendingChar } from "@marijn/find-cluster-break";

// Hermes, the engine on iOS and Android, has no Intl.Segmenter. Without it, boundaries
// come from the UAX #29 pair rules below. Where a rule would need a property Hermes
// cannot cheaply test, it errs toward joining: a missed boundary only holds text back
// for a frame, but a false one paints half a grapheme.
const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const CR = 0x0d;
const LF = 0x0a;
const ZWJ = 0x200d;

// Only Cc, Zl, and Zp count as Control here. The other Control characters are format
// characters, and treating them as ordinary ones can only join more.
const CONTROL = /^[\p{Cc}\p{Zl}\p{Zp}]/u;
// SpacingMark is Mc plus Thai and Lao SARA AM (GB9a). Mc characters that are not
// SpacingMark only make the fallback join more.
const SPACING_MARK = /^[\p{Mc}\u{0E33}\u{0EB3}]/u;
const EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}/u;
// Indic conjunct consonants are letters; testing for a letter covers them and more.
const LETTER = /^\p{L}/u;

// Grapheme_Cluster_Break=Prepend (GB9b), Unicode 16.
const PREPEND_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0600, 0x0605],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x0d4e, 0x0d4e],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x111c2, 0x111c3],
  [0x113d1, 0x113d1],
  [0x1193f, 0x1193f],
  [0x11941, 0x11941],
  [0x11a3a, 0x11a3a],
  [0x11a84, 0x11a89],
  [0x11d46, 0x11d46],
  [0x11f02, 0x11f02],
];

// Indic_Conjunct_Break=Linker (GB9c): the viramas of Bengali, Devanagari, Gujarati,
// Malayalam, Oriya, and Telugu.
const INDIC_CONJUNCT_LINKERS = new Set([0x094d, 0x09cd, 0x0acd, 0x0b4d, 0x0c4d, 0x0d4d]);

type Hangul = "L" | "V" | "T" | "LV" | "LVT" | null;

function hangulType(code: number): Hangul {
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0xa960 && code <= 0xa97c)) return "L";
  if ((code >= 0x1160 && code <= 0x11a7) || (code >= 0xd7b0 && code <= 0xd7c6)) return "V";
  if ((code >= 0x11a8 && code <= 0x11ff) || (code >= 0xd7cb && code <= 0xd7fb)) return "T";
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "LV" : "LVT";
  return null;
}

function isPrepend(code: number): boolean {
  return PREPEND_RANGES.some(([from, to]) => code >= from && code <= to);
}

function isRegionalIndicator(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

function isJoiningMark(code: number): boolean {
  return code === ZWJ || isExtendingChar(code);
}

/** The code point that ends just before `index`, and where it starts. */
function codePointBefore(text: string, index: number): { code: number; start: number } {
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return { code: text.codePointAt(index - 2)!, start: index - 2 };
    }
  }
  return { code: low, start: index - 1 };
}

function isControl(code: number): boolean {
  return code === CR || code === LF || CONTROL.test(String.fromCodePoint(code));
}

/** GB6, GB7, GB8: conjoining jamo and syllables stay together. */
function joinsHangul(before: number, after: number): boolean {
  const left = hangulType(before);
  const right = hangulType(after);
  if (left === "L") return right !== null && right !== "T";
  if (left === "LV" || left === "V") return right === "V" || right === "T";
  if (left === "LVT" || left === "T") return right === "T";
  return false;
}

/**
 * GB9c, widened to any letter and any base: a linker among the marks just before
 * `index` joins a following letter.
 */
function joinsIndicConjunct(text: string, index: number, after: number): boolean {
  if (!LETTER.test(String.fromCodePoint(after))) return false;
  let cursor = index;
  while (cursor > 0) {
    const previous = codePointBefore(text, cursor);
    if (INDIC_CONJUNCT_LINKERS.has(previous.code)) return true;
    if (!isJoiningMark(previous.code)) return false;
    cursor = previous.start;
  }
  return false;
}

/** GB12, GB13: regional indicators pair up, so an odd run before `index` joins. */
function joinsRegionalIndicator(text: string, index: number, after: number): boolean {
  if (!isRegionalIndicator(after)) return false;
  let count = 0;
  let position = index;
  while (position > 0) {
    const previous = codePointBefore(text, position);
    if (!isRegionalIndicator(previous.code)) break;
    count += 1;
    position = previous.start;
  }
  return count % 2 === 1;
}

/** UAX #29 grapheme cluster boundary between the code points around `index`. */
function isGraphemeBoundary(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  const beforeUnit = text.charCodeAt(index - 1);
  // Inside a surrogate pair.
  if (unit >= 0xdc00 && unit <= 0xdfff && beforeUnit >= 0xd800 && beforeUnit <= 0xdbff) {
    return false;
  }
  const after = text.codePointAt(index)!;
  const before = codePointBefore(text, index).code;

  if (before === CR && after === LF) return false; // GB3
  if (isControl(before) || isControl(after)) return true; // GB4, GB5
  if (joinsHangul(before, after)) return false;
  if (isJoiningMark(after)) return false; // GB9
  if (SPACING_MARK.test(String.fromCodePoint(after))) return false; // GB9a
  if (isPrepend(before)) return false; // GB9b
  if (joinsIndicConjunct(text, index, after)) return false;
  // GB11, widened to a ZWJ after anything: it joins a following pictograph.
  if (before === ZWJ && EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(after))) return false;
  if (joinsRegionalIndicator(text, index, after)) return false;
  return true; // GB999
}

/** The last grapheme cluster boundary at or before `index`. */
export function graphemeBoundaryAtOrBefore(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  if (graphemeSegmenter) return graphemeSegmenter.segment(text).containing(index)!.index;

  let position = index;
  while (position > 0 && !isGraphemeBoundary(text, position)) {
    position -= 1;
  }
  return position;
}
