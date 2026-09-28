/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddHostModal } from "@/components/add-host-modal";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

const mocks = vi.hoisted(() => ({
  probeAndUpsertDirectConnection: vi.fn(),
  probeAndUpsertConnectionFromOfferUrl: vi.fn(),
  translate: (key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: () => new Proxy({}, { get: () => ({}) }),
  },
  useUnistyles: () => ({
    theme: { colors: new Proxy({}, { get: () => "#000" }) },
  }),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => true,
}));

vi.mock("@/constants/platform", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/constants/platform");
  return { ...actual, isNative: true, isWeb: false };
});

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    Check: icon("Check"),
    ChevronDown: icon("ChevronDown"),
    ChevronRight: icon("ChevronRight"),
    Eye: icon("Eye"),
    EyeOff: icon("EyeOff"),
    Link2: icon("Link2"),
    Plus: icon("Plus"),
    X: icon("X"),
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [],
  useHostMutations: () => ({
    probeAndUpsertDirectConnection: mocks.probeAndUpsertDirectConnection,
    probeAndUpsertConnectionFromOfferUrl: mocks.probeAndUpsertConnectionFromOfferUrl,
  }),
}));

vi.mock("@/utils/test-daemon-connection", () => ({
  DaemonConnectionTestError: class DaemonConnectionTestError extends Error {},
  getConnectionAuthFailureReason: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

function MockTextInput({
  testID,
  initialValue,
  resetKey,
  onChangeText,
}: {
  testID?: string;
  initialValue?: string;
  resetKey?: string;
  onChangeText?: (value: string) => void;
}) {
  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
    [onChangeText],
  );
  return (
    <input
      key={resetKey}
      data-testid={testID}
      defaultValue={initialValue}
      onChange={handleChange}
    />
  );
}

vi.mock("./adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? <section>{children}</section> : null,
  AdaptiveTextInput: MockTextInput,
}));

// The unit project compiles JSX with the classic runtime, and add-host-modal.tsx does
// not import React itself.
(globalThis as unknown as { React: typeof React }).React = React;

function type(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function press(testId: string): void {
  fireEvent.click(screen.getByTestId(testId));
}

function addHeader(name: string, value: string): void {
  press("direct-header-add");
  const index = screen.queryAllByTestId(/^direct-header-name-/).length - 1;
  type(`direct-header-name-${index}`, name);
  type(`direct-header-value-${index}`, value);
}

function renderModal(): void {
  render(<AddHostModal visible onClose={vi.fn()} />);
}

const TARGET_CHANGED = "pairing.direct.headers.errors.targetChanged";
const APPLY_ADVANCED = "pairing.direct.headers.errors.applyAdvanced";

describe("AddHostModal custom headers", () => {
  beforeEach(() => {
    mocks.probeAndUpsertDirectConnection.mockResolvedValue({
      profile: { serverId: "srv_test" },
      serverId: "srv_test",
      hostname: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not send headers entered for one host to a host typed afterwards", async () => {
    renderModal();
    type("direct-host-input", "a.example.test");
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Secret", "secret-for-host-a");
    press("direct-host-advanced-toggle");
    type("direct-host-input", "b.example.test");

    press("direct-host-submit");

    await waitFor(() => expect(screen.getByText(TARGET_CHANGED)).toBeTruthy());
    expect(mocks.probeAndUpsertDirectConnection).not.toHaveBeenCalled();

    press("direct-host-submit");
    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce());
    expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledWith({
      endpoint: "b.example.test:6767",
      useTls: false,
    });
  });

  it("treats a port or SSL change as a different target", async () => {
    renderModal();
    type("direct-host-input", "a.example.test");
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Secret", "secret-for-host-a");
    press("direct-host-advanced-toggle");
    press("direct-ssl-toggle");

    press("direct-host-submit");

    await waitFor(() => expect(screen.getByText(TARGET_CHANGED)).toBeTruthy());
    expect(mocks.probeAndUpsertDirectConnection).not.toHaveBeenCalled();
  });

  it("keeps headers when edits end on the same target", async () => {
    renderModal();
    type("direct-host-input", "a.example.test");
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Secret", "secret-for-host-a");
    press("direct-host-advanced-toggle");
    type("direct-host-input", "a.exam");
    type("direct-host-input", "A.Example.Test");
    press("direct-ssl-toggle");
    press("direct-ssl-toggle");
    type("direct-password-input", "two words");

    press("direct-host-submit");

    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce());
    expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledWith({
      endpoint: "A.Example.Test:6767",
      useTls: false,
      password: "two words",
      headers: { "CF-Access-Client-Secret": "secret-for-host-a" },
    });
  });

  it("binds headers to the direct target shown in the Advanced URI", async () => {
    renderModal();
    type("direct-host-input", "a.example.test");
    press("direct-host-advanced-toggle");
    type("direct-host-uri-input", "tcp://b.example.test:7000?ssl=true");
    addHeader("CF-Access-Client-Secret", "secret-for-host-b");
    press("direct-host-advanced-toggle");

    press("direct-host-submit");

    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce());
    expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledWith({
      endpoint: "b.example.test:7000",
      useTls: true,
      headers: { "CF-Access-Client-Secret": "secret-for-host-b" },
    });
  });

  it("does not send headers after the Advanced URI moves to another direct target", async () => {
    renderModal();
    type("direct-host-input", "a.example.test");
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Secret", "secret-for-host-a");
    type("direct-host-uri-input", "tcp://b.example.test:6767");
    press("direct-host-advanced-toggle");

    press("direct-host-submit");

    await waitFor(() => expect(screen.getByText(TARGET_CHANGED)).toBeTruthy());
    expect(mocks.probeAndUpsertDirectConnection).not.toHaveBeenCalled();
  });

  it("starts a fresh binding once every header row is removed", async () => {
    renderModal();
    type("direct-host-input", "a.example.test");
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Secret", "secret-for-host-a");
    press("direct-header-remove-0");
    press("direct-host-advanced-toggle");
    type("direct-host-input", "b.example.test");
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Secret", "secret-for-host-b");
    press("direct-host-advanced-toggle");

    press("direct-host-submit");

    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce());
    expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledWith({
      endpoint: "b.example.test:6767",
      useTls: false,
      headers: { "CF-Access-Client-Secret": "secret-for-host-b" },
    });
  });

  it("does not send headers typed against an open Advanced URI to the host in the fields", async () => {
    renderModal();
    type("direct-host-input", "b.example.test");
    press("direct-host-advanced-toggle");
    press("direct-header-add");
    type("direct-host-uri-input", "tcp://a.example.test:6767");
    type("direct-header-name-0", "CF-Access-Client-Secret");
    type("direct-header-value-0", "secret-for-host-a");

    press("direct-host-submit");

    await waitFor(() => expect(screen.getByText(APPLY_ADVANCED)).toBeTruthy());
    expect(mocks.probeAndUpsertDirectConnection).not.toHaveBeenCalled();
    expect(screen.getByTestId("direct-header-value-0")).toBeTruthy();
  });

  it("sends headers when Advanced is open and shows the target being connected", async () => {
    renderModal();
    type("direct-host-input", "a.example.test");
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Secret", "secret-for-host-a");

    press("direct-host-submit");

    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce());
    expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledWith({
      endpoint: "a.example.test:6767",
      useTls: false,
      headers: { "CF-Access-Client-Secret": "secret-for-host-a" },
    });
  });

  it("binds a row added empty under one target to the target its content is typed for", async () => {
    renderModal();
    type("direct-host-input", "b.example.test");
    press("direct-host-advanced-toggle");
    press("direct-header-add");
    type("direct-host-uri-input", "tcp://a.example.test:6767");
    type("direct-header-name-0", "CF-Access-Client-Secret");
    type("direct-header-value-0", "secret-for-host-a");
    press("direct-host-advanced-toggle");

    press("direct-host-submit");

    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce());
    expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledWith({
      endpoint: "a.example.test:6767",
      useTls: false,
      headers: { "CF-Access-Client-Secret": "secret-for-host-a" },
    });
  });

  it("invalidates every header once content is typed for a second target", async () => {
    renderModal();
    type("direct-host-input", "a.example.test");
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Id", "client-id-for-host-a");
    type("direct-host-uri-input", "tcp://b.example.test:6767");
    addHeader("CF-Access-Client-Secret", "secret-for-host-b");
    type("direct-host-uri-input", "tcp://a.example.test:6767");
    press("direct-host-advanced-toggle");

    press("direct-host-submit");

    await waitFor(() => expect(screen.getByText(TARGET_CHANGED)).toBeTruthy());
    expect(mocks.probeAndUpsertDirectConnection).not.toHaveBeenCalled();
    expect(screen.queryByTestId("direct-header-value-0")).toBeNull();
  });

  it("binds headers entered before any host to the first host they are sent to", async () => {
    renderModal();
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Secret", "secret-for-host-a");
    press("direct-host-advanced-toggle");
    type("direct-host-input", "a.example.test");
    mocks.probeAndUpsertDirectConnection.mockRejectedValueOnce(new Error("connection refused"));
    press("direct-host-submit");
    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect((screen.getByTestId("direct-host-submit") as HTMLButtonElement).disabled).toBe(false),
    );

    type("direct-host-input", "b.example.test");
    press("direct-host-submit");

    await waitFor(() => expect(screen.getByText(TARGET_CHANGED)).toBeTruthy());
    expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce();
  });

  it("retries headers entered before any host against the same host", async () => {
    renderModal();
    press("direct-host-advanced-toggle");
    addHeader("CF-Access-Client-Secret", "secret-for-host-a");
    press("direct-host-advanced-toggle");
    type("direct-host-input", "a.example.test");
    mocks.probeAndUpsertDirectConnection.mockRejectedValueOnce(new Error("connection refused"));
    press("direct-host-submit");
    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect((screen.getByTestId("direct-host-submit") as HTMLButtonElement).disabled).toBe(false),
    );

    press("direct-host-submit");

    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledTimes(2));
    expect(mocks.probeAndUpsertDirectConnection).toHaveBeenLastCalledWith({
      endpoint: "a.example.test:6767",
      useTls: false,
      headers: { "CF-Access-Client-Secret": "secret-for-host-a" },
    });
  });

  it("sends headers entered before any host to the host typed afterwards", async () => {
    renderModal();
    press("direct-host-advanced-toggle");
    addHeader("X-Tenant", "tenant-value");
    press("direct-host-advanced-toggle");
    type("direct-host-input", "a.example.test");

    press("direct-host-submit");

    await waitFor(() => expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledOnce());
    expect(mocks.probeAndUpsertDirectConnection).toHaveBeenCalledWith({
      endpoint: "a.example.test:6767",
      useTls: false,
      headers: { "X-Tenant": "tenant-value" },
    });
  });
});
