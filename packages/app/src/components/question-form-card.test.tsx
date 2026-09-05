/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingPermission } from "@/types/shared";
import { QuestionFormCard } from "@/components/question-form-card";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: [0, 4, 8, 12, 16, 20, 24, 28, 32],
    borderWidth: { 1: 1 },
    borderRadius: { base: 4, md: 6, lg: 8 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      accent: "#2563eb",
      accentForeground: "#fff",
      surface1: "#111",
      surface2: "#222",
      border: "#444",
      borderAccent: "#555",
    },
  },
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return { Check: icon("Check"), X: icon("X") };
});

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => null,
}));

// Mirrors the EditingTextInput contract the card relies on: the editing surface owns its
// text, `initialValue` seeds it once and is never replayed, and `replaceText` is the only
// way to change what it shows. Order B in #4370 depends on exactly this.
vi.mock("@/components/ui/text-input", async () => {
  const ReactModule = await import("react");
  const EditingTextInput = ReactModule.forwardRef<
    unknown,
    {
      initialValue?: string;
      editable?: boolean;
      onChangeText?: (text: string) => void;
    }
  >((props, ref) => {
    const inputRef = ReactModule.useRef<HTMLInputElement | null>(null);
    ReactModule.useImperativeHandle(ref, () => ({
      focus() {},
      blur() {},
      isFocused: () => false,
      getText: () => inputRef.current?.value ?? "",
      replaceText: (text: string) => {
        if (inputRef.current) inputRef.current.value = text;
      },
      getNativeRef: () => inputRef.current,
    }));
    return ReactModule.createElement("input", {
      ref: inputRef,
      "data-testid": "question-form-other-input",
      defaultValue: props.initialValue ?? "",
      disabled: props.editable === false,
      onChange: (event: { target: { value: string } }) => props.onChangeText?.(event.target.value),
    });
  });
  EditingTextInput.displayName = "EditingTextInput";
  return { EditingTextInput };
});

function buildPermission(question: Record<string, unknown>): PendingPermission {
  return {
    key: "perm-1",
    agentId: "agent-1",
    request: {
      id: "perm-1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: [question] },
    },
  };
}

function renderCard(question: Record<string, unknown>) {
  const onRespond = vi.fn<(response: AgentPermissionResponse) => void>();
  const utils = render(
    <QuestionFormCard
      permission={buildPermission(question)}
      onRespond={onRespond}
      isResponding={false}
    />,
  );
  const option = (label: string) => {
    const element = utils.container.querySelector(`[aria-label="${label}"]`);
    if (!element) throw new Error(`option ${label} not rendered`);
    return element;
  };
  const otherInput = () => {
    const element = utils.container.querySelector<HTMLInputElement>(
      '[data-testid="question-form-other-input"]',
    );
    if (!element) throw new Error("other input not rendered");
    return element;
  };
  const submit = () => {
    const element = utils.container.querySelector('[data-testid="question-form-primary-action"]');
    if (!element) throw new Error("primary action not rendered");
    fireEvent.click(element);
  };
  const submittedAnswers = () => {
    const response = onRespond.mock.calls[0]?.[0];
    if (!response || response.behavior !== "allow") throw new Error("card did not submit");
    return (response.updatedInput as { answers: Record<string, string> }).answers;
  };
  return { option, otherInput, submit, submittedAnswers, onRespond };
}

const multiSelectQuestion = {
  question: "Which fruits do you like?",
  header: "Fruits",
  options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
  multiSelect: true,
  allowOther: true,
};

const singleSelectQuestion = {
  question: "Which provider?",
  header: "Provider",
  options: [{ label: "Claude Code" }, { label: "Codex" }],
  multiSelect: false,
  allowOther: true,
};

beforeEach(() => {
  vi.stubGlobal("React", React);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QuestionFormCard other answers", () => {
  it("keeps checked options when the other answer is typed afterwards (multi-select)", () => {
    const card = renderCard(multiSelectQuestion);

    fireEvent.click(card.option("Apple"));
    fireEvent.click(card.option("Cherry"));
    fireEvent.change(card.otherInput(), { target: { value: "durian" } });
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Cherry, durian" });
  });

  it("keeps the typed other answer when options are checked afterwards (multi-select)", () => {
    const card = renderCard(multiSelectQuestion);

    fireEvent.change(card.otherInput(), { target: { value: "durian" } });
    fireEvent.click(card.option("Apple"));
    fireEvent.click(card.option("Banana"));

    expect(card.otherInput().value).toBe("durian");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Banana, durian" });
  });

  it("replaces the selected option with the typed other answer (single-select)", () => {
    const card = renderCard(singleSelectQuestion);

    fireEvent.click(card.option("Codex"));
    fireEvent.change(card.otherInput(), { target: { value: "OpenCode" } });
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Provider: "OpenCode" });
  });

  it("clears the typed other answer on screen when an option is picked afterwards (single-select)", () => {
    const card = renderCard(singleSelectQuestion);

    fireEvent.change(card.otherInput(), { target: { value: "OpenCode" } });
    fireEvent.click(card.option("Codex"));

    expect(card.otherInput().value).toBe("");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Provider: "Codex" });
  });
});
