/**
 * Paced reveal for streaming assistant text.
 *
 * Deltas arrive lumpy: the daemon coalesces one message per 60ms window, carrying
 * however many characters the model happened to produce in that window. Painting
 * each delta as it lands makes the size of those lumps visible, which is what
 * reads as jagged. So arrival changes the *target* and the reveal rate is derived
 * from the backlog instead — a burst makes the text catch up faster, it doesn't
 * make it jump.
 *
 * The store keeps the full text. Only the rendered slice is paced, so copy,
 * selection, the chat outline, and scroll geometry all stay consistent with what
 * is on screen.
 *
 * Everything here is pure. The only thing the React hook adds is a frame clock,
 * which keeps the policy testable without a renderer.
 */

import { graphemeBoundaryAtOrBefore } from "@/utils/grapheme-boundary";

// Backlog is drained over this horizon. Shorter feels more like the raw arrival
// pattern; longer adds lag the user can notice at the end of a turn.
export const TEXT_REVEAL_HORIZON_MS = 150;

/** Reveal at most once per 60Hz frame, even on high-refresh displays. */
export const TEXT_REVEAL_FRAME_INTERVAL_MS = 1000 / 60;

/**
 * Share of the JS thread that reveal-driven re-renders of one block may take.
 *
 * Each reveal step re-renders the growing block, and that render costs time in
 * proportion to the block: Markdown parsing, and a full syntax-highlight parse for a
 * code fence. Hermes has no JIT, so on a phone a long block costs tens of
 * milliseconds per render, and a 60Hz reveal would leave no time for input. Frames
 * are spaced by the measured render cost instead, which keeps 60Hz where rendering
 * is cheap and slows the reveal where it is not.
 */
export const TEXT_REVEAL_RENDER_BUDGET = 0.25;

// A frame's elapsed time is clamped to this before it is used, so a long stall
// (backgrounded tab, blocked main thread) doesn't produce a wild step from one
// enormous delta.
const MAX_ELAPSED_MS = 250;

/**
 * Characters to reveal on this frame. Proportional to the backlog, so the reveal
 * accelerates when the model runs ahead and settles when it doesn't, with a
 * one-character floor so the tail always finishes.
 */
export function computeRevealStep(input: {
  backlog: number;
  elapsedMs: number;
  horizonMs?: number;
}): number {
  const { backlog } = input;
  if (backlog <= 0) {
    return 0;
  }

  const horizonMs = input.horizonMs ?? TEXT_REVEAL_HORIZON_MS;
  if (horizonMs <= 0) {
    return backlog;
  }

  const elapsedMs = Math.min(Math.max(input.elapsedMs, 0), MAX_ELAPSED_MS);
  if (elapsedMs <= 0) {
    return 0;
  }
  if (elapsedMs >= horizonMs) {
    return backlog;
  }

  const step = Math.ceil((backlog * elapsedMs) / horizonMs);
  return Math.min(backlog, Math.max(1, step));
}

const ZERO_WIDTH_JOINER = 0x200d;

/**
 * Pull a cut index back to somewhere it is safe to slice.
 *
 * A raw `slice` at an arbitrary index can split a grapheme cluster, which makes
 * one visible glyph briefly render as separate parts while the text is streaming.
 *
 * This only moves the *rendered* boundary. The reveal counter stays monotonic, so
 * a long cluster can never stall the reveal — the next frame steps past it.
 */
export function clampToSafeRevealBoundary(text: string, index: number): number {
  return graphemeBoundaryAtOrBefore(text, index);
}

export interface TextRevealFrame {
  elapsedMs: number;
  frameAtMs: number;
}

/** Time between reveal commits for a block whose renders cost `renderCostMs`. */
export function revealFrameIntervalMs(renderCostMs: number | null): number {
  return Math.max(TEXT_REVEAL_FRAME_INTERVAL_MS, (renderCostMs ?? 0) / TEXT_REVEAL_RENDER_BUDGET);
}

/** Smoothed render cost, so one slow commit such as a GC pause moves it only halfway. */
export function nextRevealRenderCost(previousMs: number | null, sampleMs: number): number {
  return previousMs === null ? sampleMs : (previousMs + sampleMs) / 2;
}

/**
 * Whether enough time has passed since the last reveal commit. Unlike the frame
 * clock this survives the reveal settling, so a block that renders slowly is not
 * re-rendered on every arrival once it has caught up.
 */
export function isRevealCommitDue(
  lastCommitAtMs: number | null,
  timestampMs: number,
  intervalMs: number,
): boolean {
  return lastCommitAtMs === null || timestampMs - lastCommitAtMs >= intervalMs;
}

/**
 * Keep reveal commits at the frame interval (60Hz unless render cost stretches it)
 * while carrying timing remainder forward so a high-refresh display does not make
 * the reveal render at hardware frame rate. The first frame after the reveal
 * settles counts as one interval, so it releases one frame's worth at that pace.
 */
export function nextTextRevealFrame(
  previousFrameAtMs: number | null,
  timestampMs: number,
  intervalMs: number = TEXT_REVEAL_FRAME_INTERVAL_MS,
): TextRevealFrame | null {
  const elapsedMs = previousFrameAtMs === null ? intervalMs : timestampMs - previousFrameAtMs;
  if (elapsedMs < intervalMs) {
    return null;
  }
  return {
    elapsedMs,
    frameAtMs: timestampMs - (elapsedMs % TEXT_REVEAL_FRAME_INTERVAL_MS),
  };
}

export interface TextRevealState {
  /** The full text as the store knows it. */
  readonly target: string;
  /** How much of it has been released. Monotonic within a message. */
  readonly revealed: number;
}

/**
 * First sight of a text is revealed whole. Only growth is paced, which is what
 * makes history hydration, timeline replay, a virtualized row remounting on
 * scroll, and an already-finished message all render complete on first paint
 * without a special case for each.
 */
export function beginTextReveal(text: string): TextRevealState {
  return { target: text, revealed: text.length };
}

/** Point the reveal at newly arrived text without changing how much is shown. */
export function retargetTextReveal(state: TextRevealState, text: string): TextRevealState {
  if (state.target === text) {
    return state;
  }
  // A shorter string means this slot is showing a different message than the one
  // the reveal position belongs to.
  return { target: text, revealed: Math.min(state.revealed, text.length) };
}

/** Release one frame's worth of characters. */
export function advanceTextReveal(
  state: TextRevealState,
  elapsedMs: number,
  horizonMs?: number,
): TextRevealState {
  const step = computeRevealStep({
    backlog: state.target.length - state.revealed,
    elapsedMs,
    ...(horizonMs !== undefined ? { horizonMs } : {}),
  });
  if (step <= 0) {
    return state;
  }
  return { target: state.target, revealed: Math.min(state.target.length, state.revealed + step) };
}

/** Release everything, for when the turn ends and nothing may be held back. */
export function completeTextReveal(state: TextRevealState): TextRevealState {
  if (state.revealed >= state.target.length) {
    return state;
  }
  return { target: state.target, revealed: state.target.length };
}

export function isTextRevealSettled(state: TextRevealState): boolean {
  return state.revealed >= state.target.length;
}

/**
 * Hold back a trailing fragment that cannot stand on its own.
 *
 * The reveal boundary is not the only place a cluster gets cut. The daemon's
 * coalescing window ends a delta wherever the window closes, so a caught-up
 * reveal can be handed half a flag and paint it — measured on a mixed-script
 * stream as frames ending in a single regional indicator. Only fragments that
 * are certainly waiting on more input are withheld: a dangling high surrogate, a
 * trailing joiner, or an odd regional indicator.
 */
function trimIncompleteTrailingCluster(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const lastUnit = text.charCodeAt(text.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    return text.slice(0, -1);
  }
  if (lastUnit === ZERO_WIDTH_JOINER) {
    return text.slice(0, -1);
  }

  const trailingRegionalIndicators = countTrailingRegionalIndicators(text);
  if (trailingRegionalIndicators % 2 === 1) {
    return text.slice(0, -2);
  }

  return text;
}

/** Number of regional indicators at the end of `text`. A flag is a pair. */
function countTrailingRegionalIndicators(text: string): number {
  let count = 0;
  let cursor = text.length;
  while (cursor >= 2) {
    const codePoint = text.codePointAt(cursor - 2);
    if (codePoint === undefined || codePoint < 0x1f1e6 || codePoint > 0x1f1ff) {
      break;
    }
    count += 1;
    cursor -= 2;
  }
  return count;
}

/**
 * What should actually be painted this frame.
 *
 * `streaming` says whether more text is still expected. While it is, a trailing
 * fragment waits for the rest of its cluster; once the turn ends everything
 * received is painted, because nothing more is coming.
 */
export function visibleRevealedText(
  state: TextRevealState,
  options?: { streaming?: boolean },
): string {
  if (state.revealed >= state.target.length) {
    return options?.streaming ? trimIncompleteTrailingCluster(state.target) : state.target;
  }
  return state.target.slice(0, clampToSafeRevealBoundary(state.target, state.revealed));
}
