/**
 * 「新しいセンサーが届いた」ことの検知に使う、「この端末が見たセンサー ID の集合」の記録と計算。
 * 記録は、この端末のブラウザ（localStorage）に持つ。サーバーは変えない。
 * localStorage が使えない（プライベートウィンドウなど）ときは、記録せず、通知も出さない（毎回「初回」になるため）。
 *
 * 【誰が使うか】NewSensorNotice（画面の上の通知カード）。
 * 【初回】記録が無いときは、いま在るセンサーをすべて「見た」ことにして、通知しない。
 */
const KEY_PREFIX = "factoreye.seenSensorIds";

/** 一度に追加・表示するセンサーの最大数。残りは編集画面のセンサー棚から追加してもらう */
export const MAX_NOTICE_SENSORS = 8;

/**
 * 記録の鍵。利用者（ワークスペース）ごとに分け、同じブラウザで別の人が入っても混ざらないようにする。
 * scope = ワークスペースの ID。OSS・ログイン無しのときは "local"
 */
export function seenKey(scope: string): string {
  return `${KEY_PREFIX}.${scope}`;
}

/** ids を、追加する分（先頭から max 件）と、残りに分ける。例: splitForAdd(["a","b","c"], 2) → { head: ["a","b"], rest: ["c"] } */
export function splitForAdd(ids: string[], max: number = MAX_NOTICE_SENSORS): { head: string[]; rest: string[] } {
  return { head: ids.slice(0, max), rest: ids.slice(max) };
}

/** 見たセンサー ID の集合。記録が無い・壊れている・読めないときは null（= 初回） */
export function readSeenSensorIds(scope: string): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(seenKey(scope));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return null;
  }
}

/** 見たセンサー ID の集合を覚える。覚えられなくても、画面は動く */
export function writeSeenSensorIds(scope: string, ids: Iterable<string>): void {
  try {
    window.localStorage.setItem(seenKey(scope), JSON.stringify([...ids]));
  } catch {
    // 覚えられなくても動く
  }
}

/**
 * いま在るセンサーのうち、まだ見ておらず、通知待ちにも入っていないものの ID（一覧の順）。
 * seen が null（初回）のときは、通知しないので空。
 * 例: findNewSensorIds(["a", "b", "c"], new Set(["a"]), ["b"]) → ["c"]
 */
export function findNewSensorIds(currentIds: string[], seen: Set<string> | null, pending: string[]): string[] {
  if (seen === null) return [];
  return currentIds.filter((id) => !seen.has(id) && !pending.includes(id));
}

/** 見た集合に ids を足した新しい集合（元は変えない）。あとで・追加の両方で使う */
export function addSeen(seen: Set<string> | null, ids: string[]): Set<string> {
  return new Set([...(seen ?? []), ...ids]);
}
