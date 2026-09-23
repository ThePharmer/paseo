import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Keyboard, StyleSheet as RNStyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useKeyboardShift } from "@/keyboard/shift";
import { PaneFind } from "@/pane-find";
import type { Theme } from "@/styles/theme";
import { fileFindStatus } from "../find/status";
import { FileSourceView } from "../source/view";
import type { FileEditorModel } from "./model";
import type { FileEditorViewProps } from "./view-contract";
import { FileEditorWebViewHost } from "./webview/host";
import { fileEditorWebViewHtml } from "./webview/html.gen";
import type { EditorFindState } from "./webview/protocol";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const EDITOR_SOURCE = { html: fileEditorWebViewHtml };
const ORIGIN_WHITELIST = ["*"];

function stayOnEditorDocument(request: { url: string }): boolean {
  return request.url === "about:blank" || request.url.startsWith("data:");
}

function injectFrame(frame: string): string {
  return `window.__PASEO_FILE_EDITOR_RECEIVE__&&window.__PASEO_FILE_EDITOR_RECEIVE__(${JSON.stringify(frame)});true;`;
}

/**
 * Hosts the web editor's CodeMirror setup in a WebView. Each attempt gets a fresh
 * WebView and host, so Retry and a crashed WebView process both start clean from
 * the model's current content.
 */
export function FileEditorView(props: FileEditorViewProps) {
  const [attempt, setAttempt] = useState(0);
  const restart = useCallback(() => setAttempt((value) => value + 1), []);
  // The docked keyboard covers the pane on every native form factor, tablets included.
  // Pad by the full keyboard height while it is up and by nothing when it is down, so
  // the editor never keeps a safe-area gap it does not need.
  const { shift, bottomInset } = useKeyboardShift();
  const keyboardInset = useAnimatedStyle(() => ({
    paddingBottom: shift.value > 0 ? shift.value + bottomInset.value : 0,
  }));
  const rootStyle = useMemo(() => [layout.root, keyboardInset], [keyboardInset]);
  // Unmounting a focused WebView is not guaranteed to close the keyboard it opened.
  useEffect(() => () => Keyboard.dismiss(), []);
  return (
    <Animated.View style={rootStyle}>
      <EditorAttempt key={attempt} {...props} onRestart={restart} />
    </Animated.View>
  );
}

function EditorAttempt({
  ref,
  model,
  filename,
  location,
  navigationRevision,
  vimEnabled,
  theme,
  onCursorChange,
  onVimModeChange,
  onReadyChange,
  onRestart,
}: FileEditorViewProps & { onRestart(): void }) {
  const webViewRef = useRef<WebView>(null);
  const callbacks = useRef({ onCursorChange, onVimModeChange });
  callbacks.current = { onCursorChange, onVimModeChange };
  const [host] = useState(
    () =>
      new FileEditorWebViewHost({
        model,
        configuration: { filename, theme, vimEnabled },
        callbacks: {
          onCursorChange: (position) => callbacks.current.onCursorChange(position),
          onVimModeChange: (mode) => callbacks.current.onVimModeChange(mode),
        },
        send: (frame) => webViewRef.current?.injectJavaScript(injectFrame(frame)),
      }),
  );
  const state = useSyncExternalStore(host.subscribe, host.getState, host.getState);

  useEffect(() => host.attach(), [host]);

  useEffect(() => {
    onReadyChange(state.status === "ready");
  }, [onReadyChange, state.status]);

  useEffect(() => {
    host.configure({ filename, theme, vimEnabled });
  }, [filename, host, theme, vimEnabled]);

  useEffect(() => {
    if (!location.lineStart) return;
    host.reveal({ lineStart: location.lineStart, lineEnd: location.lineEnd ?? location.lineStart });
  }, [host, location.lineEnd, location.lineStart, navigationRevision]);

  useImperativeHandle(
    ref,
    () => ({
      flush: () => host.flush({ final: false }),
      finish: () => host.flush({ final: true }),
      openFind: () => host.find("open"),
    }),
    [host],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => host.receive(event.nativeEvent.data),
    [host],
  );
  const webViewStyle = useMemo(
    () => [layout.webView, { backgroundColor: theme.background }],
    [theme.background],
  );

  if (state.status === "failed") {
    return (
      <EditorStartFailure
        model={model}
        filename={filename}
        location={location}
        navigationRevision={navigationRevision}
        theme={theme}
        onRetry={onRestart}
      />
    );
  }

  return (
    <View style={layout.root}>
      <WebView
        ref={webViewRef}
        testID="file-source-editor"
        source={EDITOR_SOURCE}
        originWhitelist={ORIGIN_WHITELIST}
        onShouldStartLoadWithRequest={stayOnEditorDocument}
        style={webViewStyle}
        containerStyle={webViewStyle}
        onMessage={handleMessage}
        onContentProcessDidTerminate={onRestart}
        onRenderProcessGone={onRestart}
        // CodeMirror scrolls inside the page; the page itself must never move.
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        textZoom={100}
      />
      {state.status === "loading" ? (
        <View style={styles.loading} testID="file-source-editor-loading">
          <ThemedLoadingSpinner size="small" uniProps={spinnerColorMapping} />
        </View>
      ) : null}
      {state.find.open ? <EditorFind host={host} state={state.find} /> : null}
    </View>
  );
}

function EditorFind({ host, state }: { host: FileEditorWebViewHost; state: EditorFindState }) {
  const { t } = useTranslation();
  const setQuery = useCallback((query: string) => host.setFindQuery(query), [host]);
  const next = useCallback(() => host.find("next"), [host]);
  const previous = useCallback(() => host.find("previous"), [host]);
  const close = useCallback(() => host.find("close"), [host]);
  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      host.setFindWidget({ width, height });
    },
    [host],
  );
  const replace = useMemo(
    () =>
      state.readOnly
        ? undefined
        : {
            value: state.replacement,
            onChange: (replacement: string) => host.setFindReplacement(replacement),
            onReplace: () => host.find("replace"),
            onReplaceAll: () => host.find("replaceAll"),
          },
    [host, state.readOnly, state.replacement],
  );
  return (
    <View
      pointerEvents="box-none"
      style={[styles.findOverlay, state.placement === "top" ? styles.findTop : styles.findBottom]}
    >
      <View onLayout={measure} style={styles.findFrame}>
        <PaneFind
          query={state.query}
          status={fileFindStatus(t, state)}
          canNavigate={state.total > 0}
          onQueryChange={setQuery}
          onNext={next}
          onPrevious={previous}
          onClose={close}
          replace={replace}
        />
      </View>
    </View>
  );
}

function EditorStartFailure({
  model,
  filename,
  location,
  navigationRevision,
  theme,
  onRetry,
}: Pick<FileEditorViewProps, "filename" | "location" | "navigationRevision" | "theme"> & {
  model: FileEditorModel;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const size =
    snapshot.version.status === "ready" ? snapshot.version.size : snapshot.content.length;
  return (
    <View style={layout.root} testID="file-source-editor-failed">
      <View style={styles.failure}>
        <Alert
          variant="error"
          title={t("panels.file.editor.startFailedTitle")}
          description={t("panels.file.editor.startFailedDescription")}
        >
          <Button variant="outline" size="sm" onPress={onRetry}>
            {t("common.actions.retry")}
          </Button>
        </Alert>
      </View>
      <FileSourceView
        content={snapshot.content}
        filename={filename}
        location={location}
        navigationRevision={navigationRevision}
        size={size}
        theme={theme}
        tooLargeMessage={t("panels.file.tooLargeToDisplay")}
      />
    </View>
  );
}

// Reanimated animates the root's padding, so it stays out of Unistyles.
const layout = RNStyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  webView: { flex: 1 },
});

const styles = StyleSheet.create((theme) => ({
  loading: {
    ...RNStyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
  failure: { padding: theme.spacing[3] },
  findOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "flex-end",
    zIndex: 1,
  },
  findFrame: { maxWidth: "100%", padding: theme.spacing[2] },
  findTop: { top: 0 },
  findBottom: { bottom: 0 },
}));
