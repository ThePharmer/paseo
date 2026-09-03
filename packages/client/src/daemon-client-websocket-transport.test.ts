import { afterEach, describe, expect, test, vi } from "vitest";
import {
  defaultWebSocketFactory,
  nativeWebSocketFactory,
} from "./daemon-client-websocket-transport.js";

type MockSocketArgs = [
  string,
  string | string[] | undefined,
  { headers?: Record<string, string> }?,
];

function installMockWebSocket(): { calls: MockSocketArgs[] } {
  const calls: MockSocketArgs[] = [];
  function MockWebSocket(this: unknown, ...args: MockSocketArgs) {
    calls.push(args);
  }
  vi.stubGlobal("WebSocket", MockWebSocket);
  return { calls };
}

describe("daemon-client WebSocket factories", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("nativeWebSocketFactory forwards handshake headers as the React Native options argument", () => {
    const { calls } = installMockWebSocket();

    nativeWebSocketFactory("ws://example.test/ws", {
      protocols: ["paseo.bearer.secret"],
      headers: { "CF-Access-Client-Id": "token-id.access" },
    });

    expect(calls).toEqual([
      [
        "ws://example.test/ws",
        ["paseo.bearer.secret"],
        { headers: { "CF-Access-Client-Id": "token-id.access" } },
      ],
    ]);
  });

  test("defaultWebSocketFactory keeps the browser two-argument constructor and drops headers", () => {
    const { calls } = installMockWebSocket();

    defaultWebSocketFactory("ws://example.test/ws", {
      protocols: ["paseo.bearer.secret"],
      headers: { "CF-Access-Client-Id": "token-id.access" },
    });

    expect(calls).toEqual([["ws://example.test/ws", ["paseo.bearer.secret"]]]);
  });
});
