import { parseConnectionUri } from "@/utils/daemon-endpoints";

export interface ConnectionHeaderDraft {
  id: number;
  name: string;
  value: string;
}

export type ConnectionHeaderValidationIssue =
  | { type: "missingName" }
  | { type: "invalidName"; name: string }
  | { type: "invalidValue"; name: string }
  | { type: "duplicateName"; name: string };

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function prepareConnectionHeaders(drafts: readonly ConnectionHeaderDraft[]): {
  headers?: Record<string, string>;
  issue?: ConnectionHeaderValidationIssue;
} {
  const headers: Record<string, string> = {};
  const normalizedNames = new Set<string>();

  for (const draft of drafts) {
    const name = draft.name.trim();
    const value = draft.value.trim();
    if (!name && !value) continue;
    if (!name) return { issue: { type: "missingName" } };
    if (!HTTP_HEADER_NAME_PATTERN.test(name)) {
      return { issue: { type: "invalidName", name } };
    }
    if (/\r|\n/.test(value)) {
      return { issue: { type: "invalidValue", name } };
    }

    const normalizedName = name.toLowerCase();
    if (normalizedName === "__proto__") {
      // A legal token, but a plain object cannot hold it as an own property:
      // assignment hits the inherited setter and the header silently vanishes.
      // zod's record parsing also strips it on reload, so reject it loudly.
      return { issue: { type: "invalidName", name } };
    }
    if (normalizedNames.has(normalizedName)) {
      return { issue: { type: "duplicateName", name } };
    }
    normalizedNames.add(normalizedName);
    headers[name] = value;
  }

  return Object.keys(headers).length > 0 ? { headers } : {};
}

export function normalizeConnectionHeadersRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  const drafts: ConnectionHeaderDraft[] = [];
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      return undefined;
    }
    drafts.push({ id: drafts.length, name, value: headerValue });
  }
  const result = prepareConnectionHeaders(drafts);
  return result.issue ? undefined : result.headers;
}

/**
 * Identifies the direct target (host, port, TLS) a direct connection URI points at.
 * The password is left out: it does not change where the headers are sent.
 */
export function directConnectionTargetKey(uri: string): string | null {
  try {
    const parsed = parseConnectionUri(uri);
    return `${parsed.host.toLowerCase()}|${parsed.port}|${parsed.useTls ? "tls" : "plain"}`;
  } catch {
    return null;
  }
}

/**
 * Remembers which direct target the header drafts were written for, so headers typed
 * for one host never reach another. Typing a host one character at a time passes
 * through a valid endpoint on every keystroke, so a live tracker cannot tell a partial
 * edit from a new target. The first content edit with a known target binds; a later
 * content edit for any other target invalidates the whole batch instead of carrying
 * the earlier values over. The check runs once, against the target being connected.
 */
export class ConnectionHeaderTargetBinding {
  private target: string | null = null;
  private invalid = false;

  noteContentEdit(currentTarget: string | null): void {
    if (this.invalid) return;
    if (this.target === null) {
      this.target = currentTarget;
      return;
    }
    if (currentTarget !== this.target) this.invalid = true;
  }

  /**
   * Called when headers are about to be sent. A batch typed before any target was known
   * binds to the first target it is sent to, so a retry against another target after a
   * failed attempt is caught. An existing binding is left alone.
   */
  bindToConnectTarget(connectTarget: string | null): void {
    if (this.target === null && !this.invalid) this.target = connectTarget;
  }

  isStaleFor(connectTarget: string | null): boolean {
    return this.invalid || (this.target !== null && this.target !== connectTarget);
  }

  reset(): void {
    this.target = null;
    this.invalid = false;
  }
}
