import { useEffect, useRef, useState } from "react";
import {
  createBackgroundHighlighter,
  type BackgroundHighlight,
  type BackgroundHighlighter,
  type HighlightToken,
} from "@getpaseo/highlight";

// Longest the highlighter may hold the JS thread before yielding to rendering and input.
const HIGHLIGHT_SLICE_MS = 4;

export interface CodeHighlightDisplay {
  /** Highlighted lines, from the start of the code. */
  lines: HighlightToken[][];
  /** Text after the highlighted lines that is shown unstyled until highlighting catches up. */
  plainTail: string | null;
}

/**
 * What to paint for `code` given the latest finished background highlight. Growth
 * past that highlight is painted plain, including the highlight's last line, whose
 * colors may change once the rest of it arrives.
 */
export function composeCodeHighlight(
  code: string,
  latest: BackgroundHighlight | null,
): CodeHighlightDisplay {
  if (!latest || !code.startsWith(latest.code)) return { lines: [], plainTail: code };
  if (latest.code === code) return { lines: latest.lines, plainTail: null };
  const lastLineStart = latest.code.lastIndexOf("\n") + 1;
  return { lines: latest.lines.slice(0, -1), plainTail: code.slice(lastLineStart) };
}

/**
 * Only a result that colors more lines, or that has caught up with settled code, is
 * worth a re-render. While code streams, a result that only recolors the last line
 * would re-render the block once per frame for almost nothing.
 */
function shouldPublish(
  previous: BackgroundHighlight | null,
  next: BackgroundHighlight,
  code: string,
  settled: boolean,
): boolean {
  if (previous === next) return false;
  if (previous === null || !next.code.startsWith(previous.code)) return true;
  if (settled && next.code === code) return true;
  return next.lines.length > previous.lines.length;
}

/**
 * Highlights `code` in short slices between frames and returns the latest finished
 * result. The parse is kept between renders, so code that grows by appending is
 * parsed again only near its end.
 */
export function useBackgroundHighlight(
  code: string,
  extension: string | null,
  options: { enabled: boolean; settled: boolean },
): BackgroundHighlight | null {
  const { enabled, settled } = options;
  const highlighterRef = useRef<{ extension: string; highlighter: BackgroundHighlighter | null }>(
    null,
  );
  // Each result carries the language it was highlighted as. Until the effect catches up
  // with a language change, the previous language's result is still in state, and it
  // must not be painted or cached as the new language's.
  const [latest, setLatest] = useState<{
    extension: string;
    highlight: BackgroundHighlight;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !extension) return;
    if (highlighterRef.current?.extension !== extension) {
      highlighterRef.current = {
        extension,
        highlighter: createBackgroundHighlighter(`x.${extension}`),
      };
    }
    const { highlighter } = highlighterRef.current;
    if (!highlighter) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      const startedAt = performance.now();
      const result = highlighter.work(
        code,
        () => performance.now() - startedAt >= HIGHLIGHT_SLICE_MS,
        { exact: settled },
      );
      if (result) {
        setLatest((previous) => {
          const current = previous?.extension === extension ? previous.highlight : null;
          return shouldPublish(current, result, code, settled)
            ? { extension, highlight: result }
            : previous;
        });
      }
      if (!highlighter.isCaughtUp(code, settled)) timer = setTimeout(run, 0);
    };
    timer = setTimeout(run, 0);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [code, extension, enabled, settled]);

  return enabled && latest !== null && latest.extension === extension ? latest.highlight : null;
}
