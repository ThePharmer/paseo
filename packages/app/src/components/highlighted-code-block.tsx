import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownTextSpan } from "@/components/markdown-text";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { HighlightToken } from "@getpaseo/highlight";
import type { MarkdownPhase } from "@/components/markdown/fence/types";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { composeCodeHighlight, useBackgroundHighlight } from "@/hooks/use-background-highlight";
import { useHeldWhileSelected } from "@/hooks/use-held-while-selected";
import {
  MAX_HIGHLIGHT_CHARS,
  peekTokenizedLines,
  storeTokenizedLines,
  tokenizeToLines,
} from "@/utils/highlight-cache";
import {
  markdownCopyCodeBlockDataSet,
  markdownCopyDataSet,
  TRAILING_CODE_LINE_BREAKS,
} from "@/assistant-selection-copy/markup";

interface HighlightedCodeBlockProps {
  code: string;
  language: string | null | undefined;
  /** A streaming block keeps growing, so it is always highlighted off the render path. */
  phase?: MarkdownPhase;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

// Largest settled block highlighted during render. Hermes has no JIT; a full parse
// costs roughly 10ms per 1,000 characters on a mid-range core, so anything longer is
// painted plain first and colored by the background highlighter.
const SYNC_HIGHLIGHT_MAX_CHARS = 1_000;

// Fence info strings ("```ts", "```typescript", "```ts {1,3}") map to the
// extension-based parser table in @getpaseo/highlight. Aliases here only
// cover names that don't already match an extension key in parsers.ts.
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  objc: "m",
  "objective-c": "m",
  markdown: "md",
  elixir: "ex",
};

function fenceLanguageToExtension(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  const normalized = first.replace(/^\./, "");
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function stripTerminalFenceNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

export const HighlightedCodeBlock = React.memo(function HighlightedCodeBlock({
  code,
  language,
  phase = "complete",
  inheritedStyles,
  textStyle,
}: HighlightedCodeBlockProps) {
  // Box styles (bg / padding / border / radius / margin) go on the wrapper View
  // so the absolute copy button positions relative to the visible code area,
  // not to a parent that includes the Text's own marginVertical.
  const { containerStyle, innerTextStyle } = useMemo(
    () => splitFenceStyle(inheritedStyles, textStyle),
    [inheritedStyles, textStyle],
  );
  const renderedCode = useMemo(() => stripTerminalFenceNewline(code), [code]);
  const copyDataSet = useMemo(
    () => ({ ...CODE_SURFACE_DATASET, ...markdownCopyCodeBlockDataSet(language) }),
    [language],
  );

  const extension = useMemo(() => fenceLanguageToExtension(language), [language]);
  const highlightable = extension !== null && renderedCode.length <= MAX_HIGHLIGHT_CHARS;
  const settled = phase === "complete";
  const inBackground =
    highlightable &&
    (!settled ||
      (renderedCode.length > SYNC_HIGHLIGHT_MAX_CHARS &&
        peekTokenizedLines(renderedCode, extension) === undefined));
  const syncLines = useMemo(
    () => (highlightable && !inBackground ? tokenizeToLines(renderedCode, extension) : null),
    [highlightable, inBackground, renderedCode, extension],
  );
  const containerRef = useRef<View>(null);
  // Colors replace the text nodes a selection is anchored in, so a settled block
  // waits for the reader to finish selecting before taking them.
  const background = useHeldWhileSelected(
    useBackgroundHighlight(renderedCode, extension, { enabled: inBackground, settled }),
    containerRef,
    inBackground && settled,
  );
  useEffect(() => {
    if (settled && extension && background?.exact && background.code === renderedCode) {
      storeTokenizedLines(renderedCode, extension, background.lines);
    }
  }, [settled, extension, background, renderedCode]);
  const display = useMemo(() => {
    if (syncLines) return { lines: syncLines, plainTail: null };
    if (inBackground) return composeCodeHighlight(renderedCode, background);
    return null;
  }, [syncLines, inBackground, renderedCode, background]);

  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const controlsVisible = isHovered || isNative || isCompact;
  // Copy the code without its trailing blank lines. A fence body ends in a newline,
  // and ends in more than one when the author left a blank line before the closing
  // fence; pasting any of them into a terminal runs the last line.
  const getCode = useCallback(() => code.replace(TRAILING_CODE_LINE_BREAKS, ""), [code]);

  return (
    <View
      ref={containerRef}
      style={containerStyle}
      dataSet={copyDataSet}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {display ? (
        <MarkdownTextSpan style={innerTextStyle} copyTag="code">
          {display.lines.map((tokens, index) => (
            // Lines are keyed by position: a streaming block only grows at its end.
            // oxlint-disable-next-line react/no-array-index-key
            <CodeLine key={index} tokens={tokens} leadingNewline={index > 0} />
          ))}
          {display.plainTail !== null ? (
            <CodeTextSpan
              key="plain-tail"
              text={display.lines.length > 0 ? `\n${display.plainTail}` : display.plainTail}
            />
          ) : null}
        </MarkdownTextSpan>
      ) : (
        <MarkdownTextSpan style={innerTextStyle} copyTag="code">
          {renderedCode}
        </MarkdownTextSpan>
      )}
      <CopyButton getCode={getCode} visible={controlsVisible} />
    </View>
  );
});

interface CodeLineProps {
  tokens: HighlightToken[];
  leadingNewline: boolean;
}

// A line re-renders only when its tokens change, which the highlighters avoid for
// lines whose text did not.
const CodeLine = React.memo(function CodeLine({ tokens, leadingNewline }: CodeLineProps) {
  return (
    <>
      {leadingNewline ? <CodeTextSpan text={"\n"} /> : null}
      {tokens.map((token, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <TokenSpan key={index} token={token} />
      ))}
    </>
  );
});

interface TokenSpanProps {
  token: HighlightToken;
}

const TokenSpan = React.memo(function TokenSpan({ token }: TokenSpanProps) {
  return (
    <MarkdownTextSpan style={token.style ? syntaxTokenStyleFor(token.style) : undefined}>
      {token.text}
    </MarkdownTextSpan>
  );
});

interface CodeTextSpanProps {
  text: string;
}

const CodeTextSpan = React.memo(function CodeTextSpan({ text }: CodeTextSpanProps) {
  return <MarkdownTextSpan>{text}</MarkdownTextSpan>;
});

interface SplitStyles {
  containerStyle: StyleProp<ViewStyle>;
  innerTextStyle: StyleProp<TextStyle>;
}

const CONTAINER_BASE: ViewStyle = { position: "relative" };
const WEB_SELECTABLE: TextStyle = isWeb ? ({ userSelect: "text" } as TextStyle) : {};

function splitFenceStyle(inheritedStyles: TextStyle, textStyle: TextStyle): SplitStyles {
  const { fontFamily, fontSize, color, ...box } = textStyle;
  const textOnly: TextStyle = { ...WEB_SELECTABLE };
  if (fontFamily !== undefined) textOnly.fontFamily = fontFamily;
  if (fontSize !== undefined) textOnly.fontSize = fontSize;
  if (fontSize !== undefined) textOnly.lineHeight = Math.round(fontSize * 1.45);
  if (color !== undefined) textOnly.color = color;
  return {
    containerStyle: [box as ViewStyle, CONTAINER_BASE],
    innerTextStyle: [inheritedStyles, textOnly],
  };
}

interface CopyButtonProps {
  getCode: () => string;
  visible: boolean;
}

const COPIED_RESET_MS = 1500;

const CopyButton = React.memo(function CopyButton({ getCode, visible }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const handlePress = useCallback(async () => {
    const content = getCode();
    if (!content) return;
    await Clipboard.setStringAsync(content);
    setCopied(true);
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => {
      setCopied(false);
      resetRef.current = null;
    }, COPIED_RESET_MS);
  }, [getCode]);

  const visibilityStyle = visible
    ? copyButtonStyles.containerVisible
    : copyButtonStyles.containerHidden;
  const wrapperStyle = useMemo(
    () => [copyButtonStyles.container, visibilityStyle],
    [visibilityStyle],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={wrapperStyle}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityRole="button"
      accessibilityLabel={copied ? t("message.actions.copied") : t("message.actions.copyCode")}
      hitSlop={8}
      dataSet={markdownCopyDataSet.ignore}
    >
      {({ hovered }) => {
        const iconColor = hovered
          ? copyButtonStyles.iconHoveredColor.color
          : copyButtonStyles.iconColor.color;
        return copied ? (
          <Check size={14} color={iconColor} />
        ) : (
          <Copy size={14} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const copyButtonStyles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    padding: theme.spacing[1],
  },
  containerVisible: {
    opacity: 1,
  },
  containerHidden: {
    opacity: 0,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));
