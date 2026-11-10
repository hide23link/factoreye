/**
 * リンクの画面（グラフ 1 つを 1 画面で見る）の、期間の計算と表示の文字。
 *
 * 期間は { durationMs: 長さ, endMs: 右端の時刻 } で持つ。endMs が null のときは「今」を見ている（自動で更新する）。
 * 指で変えた期間は、この画面の中だけで持ち、localStorage にも URL にも書かない（ダッシュボードの期間とは別）。
 *
 * 画面（React）に依存しない関数だけを置く（テストしやすくするため）。
 *
 * 日付・時刻は端末の時刻で扱う（ダッシュボードのグラフと同じ「表示はブラウザの地域時刻」）。
 *
 * 【誰が使うか】LinkScreen・useLinkGestures（指の操作・期間のボタン）、LinkTimeSheet（時刻の指定のシート）。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 拡大・縮小の下限・上限。上限は 7 日（ただし、表示できる最長 maxRangeForBuild を超えない） */
export const LINK_VIEW_MIN_MS = 10 * MINUTE;
export const LINK_VIEW_MAX_MS = 7 * DAY;
/** self-hosted（OSS 版）で戻れる月の数（12 か月前の月の 1 日まで） */
const OSS_PAST_MONTHS = 12;

/** 下の期間のボタン（分）: 30 分・1・3・8・24 時間 */
export const LINK_CHIPS_MINUTES = [30, 60, 180, 480, 1440] as const;

/** 画面の期間。endMs = null は「今」（右端が今で、自動で更新する） */
export interface LinkPeriod {
  durationMs: number;
  endMs: number | null;
}

/** 範囲の開始と終了（ミリ秒） */
export function periodBounds(period: LinkPeriod, now: number): { from: number; to: number } {
  const to = period.endMs ?? now;
  return { from: to - period.durationMs, to };
}

/** 長さを、下限〜上限に収める */
function clampDuration(durationMs: number, maxMs: number): number {
  return Math.min(Math.max(durationMs, LINK_VIEW_MIN_MS), Math.min(LINK_VIEW_MAX_MS, maxMs));
}

/**
 * 戻れる最も古い時刻（左右ドラッグ・時刻の指定で、これより前には行かない）。
 * maxMs = 表示できる最長（maxRangeForBuild）。SaaS は測定値の保持期間（14 日）なので、今から maxMs 前まで。
 * self-hosted は保持期間の制限が無い（maxMs が無限）ので、12 か月前の月の 1 日 0:00 まで（カレンダーで 12 か月戻れる）。
 */
export function oldestStart(now: number, maxMs: number): number {
  if (Number.isFinite(maxMs)) return now - maxMs;
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth() - OSS_PAST_MONTHS, 1).getTime();
}

/**
 * 右端を収める。左端（右端 − 長さ）が戻れる最も古い時刻より前に出ないようにし、今に届いたら「今」（null）にする。
 * 長さが「最も古い時刻〜今」より長いとき（SaaS で長さが保持期間と同じなど）は、今（null）にする（全部が入るため）。
 */
function clampEnd(endMs: number, durationMs: number, now: number, maxMs: number): number | null {
  const lowestEnd = oldestStart(now, maxMs) + durationMs;
  if (endMs >= now || lowestEnd >= now) return null;
  return Math.max(endMs, lowestEnd);
}

/**
 * 長さを変える（上下スワイプ・ピンチ・ホイール）。anchor は、動かさない位置（0 = 左端、1 = 右端）。
 * 今を見ているときに anchor = 1 なら、右端は今のまま。
 */
export function zoomPeriod(period: LinkPeriod, durationMs: number, anchor: number, now: number, maxMs: number): LinkPeriod {
  const nextDuration = clampDuration(durationMs, maxMs);
  const end = period.endMs ?? now;
  // anchor の時刻を保ったまま、長さだけを変える
  const anchorTime = end - period.durationMs * (1 - anchor);
  const nextEnd = anchorTime + nextDuration * (1 - anchor);
  return { durationMs: nextDuration, endMs: clampEnd(nextEnd, nextDuration, now, maxMs) };
}

/**
 * 上下スワイプの長さ。上へ（dy < 0）なぞると短く（拡大）、下へなぞると長くする（縮小）。
 * なぞり始めの期間から計算する（なぞる途中で計算を重ねない）。今を見ているときは右端（今）を保つ。
 */
export function swipeZoom(start: LinkPeriod, dy: number, now: number, maxMs: number): LinkPeriod {
  // 140px なぞると、長さが約 2.7 倍（e 倍）になる（モックで確かめた速さ）
  const factor = Math.exp(dy / 140);
  return zoomPeriod(start, start.durationMs * factor, start.endMs === null ? 1 : 0.5, now, maxMs);
}

/**
 * ピンチ: 指の間が広がると短く（拡大）、狭まると長くする。
 * 上下スワイプと同じく、今を見ているときは右端（今）を保ち、過去を見ているときは真ん中を保つ。
 */
export function pinchZoom(start: LinkPeriod, startDistance: number, distance: number, now: number, maxMs: number): LinkPeriod {
  const ratio = Math.max(startDistance, 1) / Math.max(distance, 1);
  return zoomPeriod(start, start.durationMs * ratio, start.endMs === null ? 1 : 0.5, now, maxMs);
}

/**
 * 左右ドラッグ: 時間を動かす。右へなぞる（dx > 0）と過去へ。長さは変えない。今より先には行かない。
 * width はグラフの横幅（px）。なぞった幅の割合だけ動かす。
 */
export function panPeriod(start: LinkPeriod, dx: number, width: number, now: number, maxMs: number): LinkPeriod {
  const end = start.endMs ?? now;
  const shift = (dx / Math.max(width, 1)) * start.durationMs;
  return { durationMs: start.durationMs, endMs: clampEnd(end - shift, start.durationMs, now, maxMs) };
}

/** 期間のボタン: 長さだけを変える（今を見ているときは今のまま、過去なら右端のまま） */
export function chipPeriod(period: LinkPeriod, minutes: number, now: number, maxMs: number): LinkPeriod {
  const durationMs = clampDuration(minutes * MINUTE, maxMs);
  return { durationMs, endMs: period.endMs === null ? null : clampEnd(period.endMs, durationMs, now, maxMs) };
}

/** 時刻の指定: その時刻から（長さは今のまま）。未来の時刻なら null（呼ぶ側が「まだ来ていない時刻です」を出す） */
export function startAtPeriod(period: LinkPeriod, startMs: number, now: number, maxMs: number): LinkPeriod | null {
  if (!Number.isFinite(startMs) || startMs >= now) return null;
  return { durationMs: period.durationMs, endMs: clampEnd(startMs + period.durationMs, period.durationMs, now, maxMs) };
}

/** リンクの設定（直近 N 分・今） */
export function linkPeriod(rangeMinutes: number): LinkPeriod {
  return { durationMs: rangeMinutes * MINUTE, endMs: null };
}

/** リンクの設定のままか（「今に戻る」を出さないため） */
export function isAtLink(period: LinkPeriod, rangeMinutes: number): boolean {
  return period.endMs === null && Math.abs(period.durationMs - rangeMinutes * MINUTE) < MINUTE;
}

/** 期間のボタンが今の長さと同じか */
export function isChipActive(period: LinkPeriod, minutes: number): boolean {
  return Math.abs(period.durationMs - minutes * MINUTE) < MINUTE;
}

// ── 表示の文字 ───────────────────────────────────────

/** 時刻を「8:05」の形にする（端末の時刻） */
export function clockText(ms: number): string {
  const date = new Date(ms);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 長さを「30 分」「1.5 時間」「2 日」の形にする */
export function durationText(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} 分`;
  const oneDecimal = (value: number) => String(Math.round(value * 10) / 10);
  if (minutes < 1440) return `${oneDecimal(minutes / 60)} 時間`;
  return `${oneDecimal(minutes / 1440)} 日`;
}

/** 期間のボタンの文字（「30 分」「3 時間」） */
export function chipText(minutes: number): string {
  return minutes < 60 ? `${minutes} 分` : `${minutes / 60} 時間`;
}

/** 上の期間の表示。今なら「直近 30 分」、過去なら「8:00〜8:30」 */
export function periodLabel(period: LinkPeriod, now: number): string {
  if (period.endMs === null) return `直近 ${durationText(period.durationMs)}`;
  const { from, to } = periodBounds(period, now);
  return `${clockText(from)}〜${clockText(to)}`;
}

/** 下の状態の行。今なら「11:30 更新・自動で更新中」、過去なら「2 時間前まで・更新を止めています」 */
export function statusText(period: LinkPeriod, now: number, updatedAt: number): string {
  if (period.endMs === null) return `${clockText(updatedAt)} 更新・自動で更新中`;
  return `${durationText(now - period.endMs)}前まで・更新を止めています`;
}

// ── 時刻の指定のシート（近道・① 時刻の帯・② カレンダー）────────────

/** 時刻の帯の刻み（分）と、初めて開いたときの時刻（8:00） */
export const PICK_STEP_MINUTES = 15;
export const DEFAULT_PICKED_MINUTES = 8 * 60;
/** 時刻の帯で選べる最後の時刻（23:45） */
export const LAST_PICK_MINUTES = 24 * 60 - PICK_STEP_MINUTES;

/** その日の 0:00（端末の時刻） */
export function dayStart(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** その日（0:00 の時刻）の、0:00 から minutes 分の時刻。例: atMinutes(11/3 0:00, 480) → 11/3 8:00 */
export function atMinutes(dayMs: number, minutes: number): number {
  const date = new Date(dayMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes).getTime();
}

/** 0:00 からの分を「8:00」の形にする */
export function minutesText(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** 時刻の帯の位置（0 = 左端の 0:00、1 = 右端の 24:00）を、15 分刻みの分（0〜1425）にする */
export function minutesAtRatio(ratio: number): number {
  const minutes = Math.round((ratio * 24 * 60) / PICK_STEP_MINUTES) * PICK_STEP_MINUTES;
  return Math.min(Math.max(minutes, 0), LAST_PICK_MINUTES);
}

/** 時刻の帯を、キーボードの左右の矢印で 15 分ずつ動かす（steps = -1 か 1） */
export function stepPicked(minutes: number, steps: number): number {
  return Math.min(Math.max(minutes + steps * PICK_STEP_MINUTES, 0), LAST_PICK_MINUTES);
}

/** 時刻の指定の近道（押すとすぐ移る）。未来になるものは呼ぶ側で押せなくする */
export function quickStarts(now: number): { label: string; startMs: number }[] {
  const today = dayStart(now);
  const yesterday = dayStart(today - HOUR); // 1 日前の 0:00（日の長さが 24 時間でない日でも合うように）
  return [
    { label: "1 時間前", startMs: now - HOUR },
    { label: "3 時間前", startMs: now - 3 * HOUR },
    { label: "今日 8:00", startMs: atMinutes(today, 8 * 60) },
    { label: "昨日 8:00", startMs: atMinutes(yesterday, 8 * 60) },
    { label: "昨日 13:00", startMs: atMinutes(yesterday, 13 * 60) },
  ];
}

/** その時刻から表示できるか（今より前で、戻れる最も古い時刻より後） */
export function canStartAt(startMs: number, now: number, oldestMs: number): boolean {
  return startMs < now && startMs >= oldestMs;
}

/** カレンダーの月。month は 0〜11（Date と同じ） */
export interface CalendarMonth {
  year: number;
  month: number;
}

/** その時刻の月 */
export function monthOf(ms: number): CalendarMonth {
  const date = new Date(ms);
  return { year: date.getFullYear(), month: date.getMonth() };
}

/** 月を数にする（前後を比べるため）。例: 2026 年 11 月 → 2026 × 12 + 10 */
export function monthIndex({ year, month }: CalendarMonth): number {
  return year * 12 + month;
}

/** 月を前後に動かす（steps = -1 で前の月、1 で次の月） */
export function shiftMonth({ year, month }: CalendarMonth, steps: number): CalendarMonth {
  return monthOf(new Date(year, month + steps, 1).getTime());
}

/** カレンダーの表。blanks = 1 日の前の空き（日曜始まり。1 日が火曜なら 2）、days = 各日の 0:00 の時刻 */
export function calendarDays({ year, month }: CalendarMonth): { blanks: number; days: number[] } {
  const count = new Date(year, month + 1, 0).getDate();
  const days = Array.from({ length: count }, (_, i) => new Date(year, month, i + 1).getTime());
  return { blanks: new Date(year, month, 1).getDay(), days };
}

/** 移ったときの知らせ。今を越えるなら「直近 30 分を表示（今を越えるため）」、今日なら「8:00 から表示」、ほかの日は「11/3 8:00 から表示」 */
export function jumpText(next: LinkPeriod, startMs: number, now: number): string {
  if (next.endMs === null) return `${periodLabel(next, now)}を表示（今を越えるため）`;
  if (dayStart(startMs) === dayStart(now)) return `${clockText(startMs)} から表示`;
  const date = new Date(startMs);
  return `${date.getMonth() + 1}/${date.getDate()} ${clockText(startMs)} から表示`;
}
