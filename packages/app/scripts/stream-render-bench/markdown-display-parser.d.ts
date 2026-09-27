// The parse step react-native-markdown-display runs on every render, imported directly
// so the benchmark can time it without React.
declare module "react-native-markdown-display/src/lib/parser" {
  import type MarkdownIt from "markdown-it";

  export default function parser<T>(
    source: string,
    renderer: (ast: unknown) => T,
    markdownIt: MarkdownIt,
  ): T;
}
