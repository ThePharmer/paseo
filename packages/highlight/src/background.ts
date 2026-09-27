import { TreeFragment, type Parser, type PartialParse, type Tree } from "@lezer/common";
import { highlightTreeLines } from "./highlighter.js";
import { getParserForFile } from "./parsers.js";
import type { HighlightToken } from "./types.js";

// Characters tokenized between yield checks. Parsing yields after every parser step.
const TOKENIZE_CHARS_PER_STEP = 2_000;

// Lines before the previous end that are tokenized again when code grows, since an
// append can recolor the statement it continues.
const RETOKENIZE_LOOKBACK_LINES = 3;

export interface BackgroundHighlight {
  /** The code these lines were highlighted from. */
  code: string;
  /** One token list per line. A line whose tokens did not change keeps its array. */
  lines: HighlightToken[][];
  /** Whether every line was tokenized, so the lines match a one-shot highlight. */
  exact: boolean;
}

interface HighlightJob {
  code: string;
  fragments: readonly TreeFragment[];
  parse: PartialParse | null;
  tree: Tree | null;
  lines: HighlightToken[][];
  /** Where tokenizing resumes, which may be partway through a line. */
  nextOffset: number;
  /** Whether the last entry in `lines` is a line that tokenizing stopped partway through. */
  lineOpen: boolean;
  /** Whether the job tokenizes every line rather than reusing earlier ones. */
  exact: boolean;
}

/**
 * Highlights code in steps the caller can interleave with rendering, so a large or
 * growing code block never holds the JS thread for a whole parse. On an engine
 * without a JIT, such as Hermes, a full parse of 10k characters takes around 100ms.
 *
 * When the code grew by appending, as a streaming code block does, the previous
 * parse is reused and only the new end is parsed again. A snapshot being worked on
 * is finished before a newer one starts, so text that keeps arriving cannot keep
 * restarting the work.
 */
export class BackgroundHighlighter {
  private fragments: readonly TreeFragment[] = [];
  private fragmentsCode: string | null = null;
  private tree: Tree | null = null;
  private job: HighlightJob | null = null;
  private finished: BackgroundHighlight | null = null;

  constructor(private readonly parser: Parser) {}

  /** The most recent finished highlight, which may be for an older snapshot. */
  get latest(): BackgroundHighlight | null {
    return this.finished;
  }

  /**
   * Whether the latest highlight is for `code`. With `exact`, it must also have
   * tokenized every line, so it matches a one-shot highlight of the same code.
   */
  isCaughtUp(code: string, exact = false): boolean {
    return this.job === null && this.finished?.code === code && (!exact || this.finished.exact);
  }

  /**
   * Work toward highlighting `code` until `shouldYield` returns true or it is done.
   *
   * Appending rarely changes how lines well before the end are colored, so while code
   * grows only the last few lines are tokenized again. Pass `exact` once the code has
   * settled to tokenize every line from the finished parse.
   */
  work(
    code: string,
    shouldYield: () => boolean,
    options?: { exact?: boolean },
  ): BackgroundHighlight | null {
    const exact = options?.exact ?? false;
    while (!this.isCaughtUp(code, exact)) {
      this.job ??= this.startJob(code, exact);
      if (!this.advance(this.job, shouldYield)) break;
      this.finished = this.finish(this.job);
      this.job = null;
      if (shouldYield()) break;
    }
    return this.finished;
  }

  private startJob(code: string, exact: boolean): HighlightJob {
    if (this.fragmentsCode === code && this.tree) {
      // Already parsed; only the full tokenization is missing.
      return {
        code,
        fragments: this.fragments,
        parse: null,
        tree: this.tree,
        lines: [],
        nextOffset: 0,
        lineOpen: false,
        exact: true,
      };
    }
    const previous = this.fragmentsCode;
    const appended = previous !== null && code.startsWith(previous);
    const fragments = appended
      ? TreeFragment.applyChanges(this.fragments, [
          {
            fromA: previous.length,
            toA: previous.length,
            fromB: previous.length,
            toB: code.length,
          },
        ])
      : [];
    const kept =
      appended && !exact && this.finished?.code === previous
        ? Math.max(0, this.finished.lines.length - 1 - RETOKENIZE_LOOKBACK_LINES)
        : 0;
    return {
      code,
      fragments,
      parse: this.parser.startParse(code, fragments),
      tree: null,
      lines: kept > 0 ? this.finished!.lines.slice(0, kept) : [],
      nextOffset: kept > 0 ? lineStartOffset(code, kept) : 0,
      lineOpen: false,
      exact: kept === 0,
    };
  }

  /** Returns true once the job has parsed and tokenized all of its code. */
  private advance(job: HighlightJob, shouldYield: () => boolean): boolean {
    while (job.parse) {
      const tree = job.parse.advance();
      if (tree) {
        job.tree = tree;
        job.parse = null;
        this.tree = tree;
        this.fragments = TreeFragment.addTree(tree, job.fragments);
        this.fragmentsCode = job.code;
      } else if (shouldYield()) {
        return false;
      }
    }

    const { code } = job;
    while (job.tree) {
      // Steps may end partway through a line, so one long line cannot become one
      // long step. The next step continues that line.
      const from = job.nextOffset;
      const to = Math.min(code.length, from + TOKENIZE_CHARS_PER_STEP);
      const [first, ...rest] = highlightTreeLines(code, job.tree, from, to);
      if (job.lineOpen) {
        job.lines[job.lines.length - 1] = continueLine(job.lines[job.lines.length - 1]!, first!);
      } else {
        job.lines.push(first!);
      }
      job.lines.push(...rest);
      if (to === code.length) return true;
      job.nextOffset = to;
      job.lineOpen = true;
      if (shouldYield()) return false;
    }
    return true;
  }

  private finish(job: HighlightJob): BackgroundHighlight {
    const previous = this.finished?.lines ?? [];
    const lines = job.lines.map((line, index) => {
      const before = previous[index];
      return before && areSameTokens(before, line) ? before : line;
    });
    return { code: job.code, lines, exact: job.exact };
  }
}

/**
 * Append the tokens of a line's continuation, merging the two tokens that meet when
 * they share a style so the line matches one tokenized in a single step.
 */
function continueLine(line: HighlightToken[], next: HighlightToken[]): HighlightToken[] {
  const added = next.filter((token) => token.text.length > 0);
  if (added.length === 0) return line;
  const merged = line.filter((token) => token.text.length > 0);
  const last = merged[merged.length - 1];
  if (last && last.style === added[0]!.style) {
    merged[merged.length - 1] = { text: last.text + added[0]!.text, style: last.style };
    merged.push(...added.slice(1));
  } else {
    merged.push(...added);
  }
  return merged;
}

/** Offset where the line with index `line` starts. */
function lineStartOffset(code: string, line: number): number {
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    offset = code.indexOf("\n", offset) + 1;
  }
  return offset;
}

function areSameTokens(left: HighlightToken[], right: HighlightToken[]): boolean {
  if (left === right) return true;
  return (
    left.length === right.length &&
    left.every((token, index) => {
      const other = right[index]!;
      return token.text === other.text && token.style === other.style;
    })
  );
}

/** A background highlighter for the file's language, or null when it has no grammar. */
export function createBackgroundHighlighter(filename: string): BackgroundHighlighter | null {
  const parser = getParserForFile(filename);
  return parser ? new BackgroundHighlighter(parser) : null;
}
