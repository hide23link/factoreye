/**
 * 画面全体の「更新間隔」の選択肢と、グラフの取り直し間隔の決め方（計算だけ。画面は持たない）。
 *
 * - 選択は「各グラフの設定に従う」（既定。今までの動き）、Off（自動で取り直さない）、10 秒〜5 分
 * - 10 秒は OSS（自前ホスト）だけ。SaaS（multi_tenant）は 30 秒以上だけを出す（サーバーの負荷のため）
 *
 * 【誰が使うか】store/useRefreshStore.ts（選択の保存）、hooks/queries.ts（取り直し間隔）、
 * components/TimeRangeControls.tsx（選択肢の表示と最終更新時刻）。
 */

/** 選択の種類。"graph" = 各グラフの設定に従う、"off" = 自動で取り直さない、数字 = その秒数ごと */
export type RefreshChoice = "graph" | "off" | "10" | "30" | "60" | "300";

export const REFRESH_CHOICES: ReadonlyArray<{ value: RefreshChoice; label: string }> = [
  { value: "graph", label: "各グラフの設定" },
  { value: "off", label: "Off（手動）" },
  { value: "10", label: "10 秒" },
  { value: "30", label: "30 秒" },
  { value: "60", label: "1 分" },
  { value: "300", label: "5 分" },
];

export const DEFAULT_REFRESH_CHOICE: RefreshChoice = "graph";

/** 画面に出す選択肢。SaaS では 10 秒を出さない */
export function availableRefreshChoices(isMultiTenant: boolean) {
  return REFRESH_CHOICES.filter((c) => !(isMultiTenant && c.value === "10"));
}

/** 保存されていた値を、使える選択に直す。知らない値・SaaS での 10 秒は、既定（各グラフの設定）にする */
export function sanitizeRefreshChoice(value: unknown, isMultiTenant: boolean): RefreshChoice {
  const found = availableRefreshChoices(isMultiTenant).find((c) => c.value === value);
  return found ? found.value : DEFAULT_REFRESH_CHOICE;
}

/**
 * 取り直しの間隔（ミリ秒）を決める。戻り値が false なら自動では取り直さない。
 * 例: resolveRefetchMs("graph", 30000) → 30000 / resolveRefetchMs("off", 30000) → false / resolveRefetchMs("10", 30000) → 10000
 */
export function resolveRefetchMs(choice: RefreshChoice, graphMs: number): number | false {
  if (choice === "graph") return graphMs;
  if (choice === "off") return false;
  return Number(choice) * 1000;
}

/**
 * 取得のキャッシュのうち、最後にデータが更新された時刻（ミリ秒）。1 つも無ければ null。
 * 例: latestUpdatedAt([{ dataUpdatedAt: 0 }, { dataUpdatedAt: 5 }]) → 5（0 は「まだ取れていない」ので無視）
 */
export function latestUpdatedAt(queries: ReadonlyArray<{ dataUpdatedAt: number }>): number | null {
  const times = queries.map((q) => q.dataUpdatedAt).filter((t) => t > 0);
  return times.length > 0 ? Math.max(...times) : null;
}

/** 最終更新の表示用の時刻（例: 07:51:41。端末のローカル時刻） */
export function formatUpdatedAt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
