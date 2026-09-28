import { describe, expect, test } from "vitest";
import {
  formatGcSafetyNetSection,
  formatHostRuntimeSection,
  formatServerInfoSection,
  redactAppDiagnosticReport,
} from "./app-diagnostic-report";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { defaultHostAppearance } from "@/hosts/appearance";

function makeHost(): HostProfile {
  return {
    serverId: "srv-secret",
    label: "Secret host",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    preferredConnectionId: "direct:secret.example.test:6767",
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    connections: [
      {
        id: "direct:secret.example.test:6767",
        type: "directTcp",
        endpoint: "secret.example.test:6767",
        useTls: true,
        password: "tcp-password",
      },
      {
        id: "relay:relay.secret.test:443",
        type: "relay",
        relayEndpoint: "relay.secret.test:443",
        useTls: true,
        daemonPublicKeyB64: "daemon-public-key-secret",
      },
      {
        id: "socket:/tmp/paseo-secret.sock",
        type: "directSocket",
        path: "/tmp/paseo-secret.sock",
      },
      {
        id: "pipe:\\\\.\\pipe\\paseo-secret",
        type: "directPipe",
        path: "\\\\.\\pipe\\paseo-secret",
      },
    ],
  };
}

describe("app diagnostics report", () => {
  test("reports whether the connected daemon is managed by Paseo Desktop", () => {
    const report = formatServerInfoSection({
      status: "server_info",
      serverId: "srv-desktop-managed",
      hostname: "desktop-host.local",
      version: "0.1.108",
      desktopManaged: true,
    });

    expect(report).toContain("Desktop managed: yes");
  });

  test("formats connection rows without raw connection details", () => {
    const host = makeHost();
    const snapshot: HostRuntimeSnapshot = {
      serverId: host.serverId,
      activeConnectionId: "relay:relay.secret.test:443",
      activeConnection: {
        type: "relay",
        endpoint: "relay.secret.test:443",
        display: "relay",
      },
      connectionStatus: "online",
      client: null,
      lastError: null,
      hasFailedConnectAttempt: false,
      lastOnlineAt: "2026-06-25T00:00:00.000Z",
      agentDirectoryStatus: "ready",
      agentDirectoryError: null,
      hasEverLoadedAgentDirectory: true,
      probeByConnectionId: new Map([
        ["direct:secret.example.test:6767", { status: "available", latencyMs: 42 }],
        ["relay:relay.secret.test:443", { status: "available", latencyMs: 8 }],
      ]),
      clientGeneration: 1,
      connectionEpoch: 1,
    };

    const report = formatHostRuntimeSection({ host, snapshot });

    expect(report).toContain("direct TCP");
    expect(report).toContain("relay");
    expect(report).toContain("local socket");
    expect(report).toContain("local pipe");
    expect(report).not.toContain("secret.example.test");
    expect(report).not.toContain("relay.secret.test");
    expect(report).not.toContain("daemon-public-key-secret");
    expect(report).not.toContain("/tmp/paseo-secret.sock");
    expect(report).not.toContain("tcp-password");
  });

  test("redacts saved connection secrets from collected daemon and desktop text", () => {
    const host = makeHost();
    const redacted = redactAppDiagnosticReport(
      [
        "Desktop app log tail",
        "secret.example.test:6767",
        "relay.secret.test:443",
        "daemon-public-key-secret",
        "/tmp/paseo-secret.sock",
        "\\\\.\\pipe\\paseo-secret",
        "password=tcp-password",
        "paseo://pairing-secret",
      ].join("\n"),
      [host],
    );

    expect(redacted).not.toContain("secret.example.test");
    expect(redacted).not.toContain("relay.secret.test");
    expect(redacted).not.toContain("daemon-public-key-secret");
    expect(redacted).not.toContain("/tmp/paseo-secret.sock");
    expect(redacted).not.toContain("\\\\.\\pipe\\paseo-secret");
    expect(redacted).not.toContain("tcp-password");
    expect(redacted).not.toContain("pairing-secret");
  });

  test("formats GC safety net events one per line", () => {
    const MB = 1024 * 1024;
    const stats = { numGCs: 41, heapSizeBytes: 60 * MB, gcTimeMs: 812.4, externalBytes: 2 * MB };
    const report = formatGcSafetyNetSection({
      mode: "balloon",
      notes: [],
      baselineBytes: 300 * MB,
      nativeHeapBytes: 310 * MB,
      events: [
        {
          kind: "trigger",
          at: 123_456,
          nativeHeapBytes: 512 * MB,
          baselineBytes: 300 * MB,
          pressureBytes: 212 * MB,
          stats,
        },
        { kind: "collected", at: 126_156, sinceTriggerMs: 2700, nativeHeapBytes: 280 * MB, stats },
        { kind: "rebaseline", at: 128_156, baselineBytes: 270 * MB, stats: null },
        {
          kind: "fallback-gc",
          at: 200_000,
          pauseMs: 181.6,
          nativeHeapBeforeBytes: 900 * MB,
          nativeHeapAfterBytes: 500 * MB,
          stats,
        },
      ],
    });

    expect(report).toBe(
      [
        "GC safety net",
        "  Mode: balloon",
        "  Notes: none",
        "  Native heap: 310MB",
        "  Baseline: 300MB",
        "  Event 1: t+123.5s trigger nativeHeap=512MB baseline=300MB pressure=212MB numGCs=41 gcTime=812ms jsHeap=60MB external=2MB",
        "  Event 2: t+126.2s collected after=2.7s nativeHeap=280MB numGCs=41 gcTime=812ms jsHeap=60MB external=2MB",
        "  Event 3: t+128.2s rebaseline baseline=270MB stats=unavailable",
        "  Event 4: t+200.0s fallback-gc pause=182ms nativeHeap=900MB->500MB numGCs=41 gcTime=812ms jsHeap=60MB external=2MB",
      ].join("\n"),
    );
  });

  test("says why the GC safety net is off", () => {
    const report = formatGcSafetyNetSection({
      mode: "off",
      notes: ["native module PaseoGcPressure missing"],
      baselineBytes: null,
      nativeHeapBytes: null,
      events: [],
    });

    expect(report).toBe(
      [
        "GC safety net",
        "  Mode: off",
        "  Notes: native module PaseoGcPressure missing",
        "  Native heap: unknown",
        "  Baseline: unknown",
        "  Events: none",
      ].join("\n"),
    );
  });
});
