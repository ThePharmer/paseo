import type { TFunction } from "i18next";

/** The match count shown inside the Find field, shared by the web and native editors. */
export function fileFindStatus(
  t: TFunction,
  state: { query: string; current: number; total: number; limited: boolean },
): string {
  if (!state.query) return "";
  const total = `${state.total}${state.limited ? "+" : ""}`;
  if (state.total === 0) return t("paneFind.noMatches");
  if (state.current) return t("paneFind.position", { current: state.current, total });
  return t("paneFind.total", { total });
}
