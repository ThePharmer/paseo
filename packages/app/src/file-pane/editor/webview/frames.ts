/**
 * Transport framing for the native editor bridge. A message is serialized to JSON
 * and cut into frames no longer than `FRAME_DATA_LENGTH`, so a whole document never
 * crosses `postMessage` or `injectJavaScript` as one string. Frames of one message
 * are sent back to back and both transports preserve order, so the receiver keeps
 * at most one partial message.
 */
export const FRAME_DATA_LENGTH = 64 * 1024;

interface Frame {
  id: number;
  index: number;
  count: number;
  data: string;
}

export function encodeFrames(input: {
  message: unknown;
  id: number;
  dataLength?: number;
}): string[] {
  const json = JSON.stringify(input.message);
  const parts = splitText(json, input.dataLength ?? FRAME_DATA_LENGTH);
  return parts.map((data, index) =>
    JSON.stringify({ id: input.id, index, count: parts.length, data } satisfies Frame),
  );
}

function splitText(text: string, length: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length || parts.length === 0) {
    let end = Math.min(start + length, text.length);
    // A surrogate pair split across frames becomes two lone surrogates, which a
    // bridge that transcodes through UTF-8 replaces with U+FFFD.
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Reassembles frames into parsed JSON values. Anything malformed is dropped. */
export class FrameAssembler {
  private partial: { id: number; count: number; parts: string[] } | null = null;

  receive(raw: string): unknown {
    const frame = parseFrame(raw);
    if (!frame) return undefined;
    if (frame.index === 0) {
      this.partial = { id: frame.id, count: frame.count, parts: [] };
    }
    const partial = this.partial;
    if (
      !partial ||
      partial.id !== frame.id ||
      partial.count !== frame.count ||
      partial.parts.length !== frame.index
    ) {
      this.partial = null;
      return undefined;
    }
    partial.parts.push(frame.data);
    if (partial.parts.length < partial.count) return undefined;
    this.partial = null;
    return parseJson(partial.parts.join(""));
  }
}

function parseFrame(raw: string): Frame | null {
  const value = parseJson(raw);
  if (!isRecord(value)) return null;
  const { id, index, count, data } = value;
  if (!isInteger(id) || !isInteger(index) || !isInteger(count) || typeof data !== "string") {
    return null;
  }
  if (count < 1 || index < 0 || index >= count) return null;
  return { id, index, count, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
