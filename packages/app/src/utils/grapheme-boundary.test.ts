import { afterEach, describe, expect, it, vi } from "vitest";

type Boundary = (text: string, index: number) => number;

async function loadBoundary(withSegmenter: boolean): Promise<Boundary> {
  vi.resetModules();
  vi.unstubAllGlobals();
  if (!withSegmenter) vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
  const module = await import("./grapheme-boundary");
  return module.graphemeBoundaryAtOrBefore;
}

function expectBoundaries(boundary: Boundary, text: string, boundaries: number[]) {
  for (let index = 0; index <= text.length; index += 1) {
    const expected = boundaries.toReversed().find((candidate) => candidate <= index);
    expect(boundary(text, index), `${JSON.stringify(text)} at ${index}`).toBe(expected);
  }
}

const ZWJ = "\u{200D}";
const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;

const sharedCases = [
  { name: "plain text", text: "hello", boundaries: [0, 1, 2, 3, 4, 5] },
  { name: "surrogate pair", text: "a\u{1F600}b", boundaries: [0, 1, 3, 4] },
  { name: "combining mark", text: "e\u{0301}x", boundaries: [0, 2, 3] },
  { name: "ZWJ sequence", text: `${family}!`, boundaries: [0, family.length, family.length + 1] },
  { name: "skin tone modifier", text: "\u{1F44D}\u{1F3FD}!", boundaries: [0, 4, 5] },
  { name: "variation selector", text: "\u{2764}\u{FE0F}!", boundaries: [0, 2, 3] },
  { name: "flags", text: "a\u{1F1FA}\u{1F1F8}\u{1F1EC}\u{1F1E7}b", boundaries: [0, 1, 5, 9, 10] },
  { name: "precomposed Hangul", text: "a\u{AC00}b", boundaries: [0, 1, 2, 3] },
  // KA + VISARGA: a spacing mark stays with its base.
  { name: "spacing mark", text: "a\u{0915}\u{0903}b", boundaries: [0, 1, 3, 4] },
  // NA, MA, then SA + VIRAMA + TA + vowel sign E: a conjunct across the virama is one cluster.
  {
    name: "Indic conjunct",
    text: "\u{0928}\u{092E}\u{0938}\u{094D}\u{0924}\u{0947}",
    boundaries: [0, 1, 2, 6],
  },
  // KA + VIRAMA + NUKTA + KA: an Extend between the linker and the consonant.
  {
    name: "Indic conjunct with a mark after the virama",
    text: "a\u{0915}\u{094D}\u{093C}\u{0915}b",
    boundaries: [0, 1, 5, 6],
  },
  // Thai KO KAI + SARA AM: SpacingMark without being Mc.
  { name: "Thai SARA AM", text: "\u{0E01}\u{0E33}!", boundaries: [0, 2, 3] },
  // Conjoining jamo L + V + T.
  { name: "decomposed Hangul", text: "a\u{1100}\u{1161}\u{11A8}b", boundaries: [0, 1, 4, 5] },
  { name: "CRLF", text: "a\r\nb", boundaries: [0, 1, 3, 4] },
];

// One or more code points from every Grapheme_Cluster_Break class, plus the Indic
// conjunct classes, so random strings exercise every pair rule.
const CLASS_SAMPLES = [
  "a",
  "Z",
  " ",
  "中",
  "\r",
  "\n",
  "\u{0001}",
  "\u{2028}",
  "\u{0301}",
  "\u{093C}",
  "\u{FE0F}",
  "\u{1F3FD}",
  "\u{200D}",
  "\u{200C}",
  "\u{0903}",
  "\u{093E}",
  "\u{0E33}",
  "\u{0EB3}",
  "\u{0600}",
  "\u{110BD}",
  "\u{1100}",
  "\u{1161}",
  "\u{11A8}",
  "\u{AC00}",
  "\u{AC01}",
  "\u{1F1FA}",
  "\u{1F1F8}",
  "\u{1F468}",
  "\u{2764}",
  "\u{00A9}",
  "\u{0915}",
  "\u{094D}",
  "\u{0924}",
  "\u{09CD}",
  "\u{0995}",
];

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe.each([
  { engine: "with Intl.Segmenter", withSegmenter: true },
  { engine: "without Intl.Segmenter (Hermes)", withSegmenter: false },
])("graphemeBoundaryAtOrBefore $engine", ({ withSegmenter }) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(sharedCases)("keeps a $name whole", async ({ text, boundaries }) => {
    expectBoundaries(await loadBoundary(withSegmenter), text, boundaries);
  });

  it("clamps out-of-range indexes to the ends", async () => {
    const boundary = await loadBoundary(withSegmenter);
    expect(boundary("hello", -3)).toBe(0);
    expect(boundary("hello", 99)).toBe(5);
  });
});

describe("graphemeBoundaryAtOrBefore without Intl.Segmenter", () => {
  const Segmenter = Intl.Segmenter;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("only ever returns a real boundary at or before the index", async () => {
    const oracle = new Segmenter(undefined, { granularity: "grapheme" });
    const boundary = await loadBoundary(false);
    const random = seededRandom(7);
    let checked = 0;
    let exact = 0;
    for (let sample = 0; sample < 3_000; sample += 1) {
      const length = 1 + Math.floor(random() * 8);
      const text = Array.from(
        { length },
        () => CLASS_SAMPLES[Math.floor(random() * CLASS_SAMPLES.length)]!,
      ).join("");
      const real = new Set([...oracle.segment(text)].map((segment) => segment.index));
      real.add(text.length);
      for (let index = 0; index <= text.length; index += 1) {
        const result = boundary(text, index);
        const expected = oracle.segment(text).containing(Math.min(index, text.length - 1))!.index;
        const context = `${JSON.stringify(text)} at ${index}`;
        expect(real.has(result), `${context} returned ${result}`).toBe(true);
        expect(result, context).toBeLessThanOrEqual(index);
        if (index < text.length) {
          checked += 1;
          if (result === expected) exact += 1;
        }
      }
    }
    // Erring toward joining holds text back only in rare sequences.
    expect(exact / checked).toBeGreaterThan(0.97);
  });
});
