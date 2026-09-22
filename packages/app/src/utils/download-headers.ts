/**
 * Header names are case-insensitive, so the derived Authorization value replaces a custom
 * entry under any spelling, not just the canonical one. This mirrors `buildHandshakeHeaders`
 * in `packages/client/src/daemon-client.ts`, which stays private to the client package.
 */
export function buildDownloadHeaders(
  customHeaders: Record<string, string> | undefined,
  authorization: string | null,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(customHeaders ?? {})) {
    if (authorization && name.toLowerCase() === "authorization") continue;
    headers[name] = value;
  }
  if (authorization) {
    headers.Authorization = authorization;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
