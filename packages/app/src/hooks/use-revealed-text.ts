import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  advanceTextReveal,
  beginTextReveal,
  completeTextReveal,
  isRevealCommitDue,
  isTextRevealSettled,
  nextRevealRenderCost,
  nextTextRevealFrame,
  retargetTextReveal,
  revealFrameIntervalMs,
  type TextRevealState,
  visibleRevealedText,
} from "@/agent-stream/text-reveal";
import type { MarkdownPhase } from "@/components/markdown/fence/types";

/**
 * Binds the paced reveal in @/agent-stream/text-reveal to a frame clock.
 *
 * All of the policy — what is revealed when, and where it is safe to cut — lives
 * in that module and is tested there. This hook only owns the requestAnimationFrame
 * wiring and the render-cost sample, so the rendered behavior is covered end to end
 * by `packages/app/e2e/browser/agent-stream-smoothness.spec.ts`.
 *
 * The cost sample runs from this component's render to its layout effect. Layout
 * effects run after the whole subtree has rendered and committed, so the sample
 * covers the Markdown and highlighting work of the block this hook reveals.
 */
export function useRevealedText(text: string, phase: MarkdownPhase): string {
  const stateRef = useRef<TextRevealState>(beginTextReveal(text));
  const [, forceRender] = useState(0);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const lastCommitAtRef = useRef<number | null>(null);
  const renderCostRef = useRef<number | null>(null);
  const renderStartedAtRef = useRef(0);
  const committedLengthRef = useRef<number | null>(null);

  stateRef.current = retargetTextReveal(stateRef.current, text);
  renderStartedAtRef.current = performance.now();
  const visibleText = visibleRevealedText(stateRef.current, { streaming: phase === "streaming" });

  useLayoutEffect(() => {
    // Only a commit that changed what is painted re-rendered the block; the others
    // were cut short by memoization and would understate the cost.
    if (phase === "streaming" && committedLengthRef.current !== visibleText.length) {
      renderCostRef.current = nextRevealRenderCost(
        renderCostRef.current,
        performance.now() - renderStartedAtRef.current,
      );
    }
    committedLengthRef.current = visibleText.length;
  });

  useEffect(() => {
    const settle = () => {
      lastFrameAtRef.current = null;
      const next = completeTextReveal(stateRef.current);
      if (next !== stateRef.current) {
        stateRef.current = next;
        forceRender((tick) => tick + 1);
      }
    };

    if (phase !== "streaming") {
      settle();
      return;
    }
    if (isTextRevealSettled(stateRef.current)) {
      lastFrameAtRef.current = null;
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      settle();
      return;
    }

    const tick = (timestamp: number) => {
      frameRef.current = null;
      const intervalMs = revealFrameIntervalMs(renderCostRef.current);
      const frame = isRevealCommitDue(lastCommitAtRef.current, timestamp, intervalMs)
        ? nextTextRevealFrame(lastFrameAtRef.current, timestamp, intervalMs)
        : null;
      if (!frame) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      lastFrameAtRef.current = frame.frameAtMs;

      const next = advanceTextReveal(stateRef.current, frame.elapsedMs);
      if (next !== stateRef.current) {
        stateRef.current = next;
        lastCommitAtRef.current = timestamp;
        forceRender((count) => count + 1);
      }
      if (!isTextRevealSettled(stateRef.current)) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [text, phase]);

  return visibleText;
}
