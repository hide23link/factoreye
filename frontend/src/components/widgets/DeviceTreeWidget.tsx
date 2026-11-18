/**
 * 機器の系統図のウィジェット。サーバーを上に置き、そこへつながる機器（機器に属さないセンサーは 1 つずつ）を下に並べる。
 * 機器は 1 列（横）に並べる。入りきらないときは、横にスクロールする（段に折り返さない）。
 * 各機器に、最後の受信からの時間と状態の色（緑の線＝受信、橙＝注意、点線＝受信なし・未受信）を出す。
 * 状態の決め方は全体監視の札と同じ（lib/overview.ts の buildStrips）。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "DeviceTree" のときに出す。センサーの設定は要らない。
 * 【引数（props）】なし。
 */
import { useRef } from "react";

import { useElementSize } from "../../hooks/useElementSize";
import { useAlarms, useLatestReadings, useSensors } from "../../hooks/queries";
import { useNow } from "../../hooks/useNow";
import { buildStrips, formatAge, type Strip, type StripState } from "../../lib/overview";
import { ErrorNotice } from "../ErrorNotice";

/** 1 台の札に割り当てる幅の下限（px）。これより狭くなるときは、全体を広げて横にスクロールする */
const TRUNK_CELL_PX = 118;

const LINE_COLOR: Record<StripState, string> = {
  critical: "var(--fe-red)",
  warning: "var(--fe-amb)",
  normal: "var(--fe-ok)",
  never: "var(--fe-mut)",
};

/**
 * 外側の枠は、読み込み中も常に出す（枠の幅を測り始めるのは最初の描画の後 1 回だけなので、枠がデータの到着後に現れると、
 * 幅が 0 のままになり、列の数が枠の幅を無視して常に最大になってしまう）。
 */
export function DeviceTreeWidget() {
  const rootRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(rootRef);
  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-auto px-1 text-xs" role="group" aria-label="機器の系統図">
      <DeviceTreeBody width={width} />
    </div>
  );
}

function DeviceTreeBody({ width }: { width: number }) {
  const sensors = useSensors();
  const latest = useLatestReadings();
  const active = useAlarms("active", 200);
  const acknowledged = useAlarms("acknowledged", 200);
  // 「◯ 秒前」を進めるため、10 秒ごとに描き直す
  const now = useNow(10_000);

  if (!sensors.data && sensors.isError) return <ErrorNotice message="機器の様子を取得できませんでした。" onRetry={() => void sensors.refetch()} />;
  if (!sensors.data || !latest.data) return <p className="text-sm text-gray-500">読み込み中...</p>;

  const unresolved = [...(active.data?.alarms ?? []), ...(acknowledged.data?.alarms ?? [])];
  // 名前順に並べる（状態順だと、色が変わるたびに場所が入れ替わって探しにくい）
  const strips = buildStrips(
    sensors.data,
    latest.data.readings,
    unresolved,
    now,
  ).sort((a, b) => a.title.localeCompare(b.title, "ja"));
  const newest = Math.max(0, ...strips.map((strip) => strip.lastTime ?? 0));
  // 機器は 1 列に並べる。1 台の幅は 7rem 以上で、枠に入りきらないときは、全体を広げて横にスクロールする
  const trunkWidth = Math.max(width, strips.length * TRUNK_CELL_PX);

  if (strips.length === 0) return <p className="text-sm text-gray-500">センサーがまだありません</p>;

  return (
    <div className="flex flex-col" style={{ minWidth: trunkWidth }}>
      <div className="mx-auto flex flex-col items-center rounded-sm border px-4 py-1.5" style={{ borderColor: "var(--fe-mut)", background: "var(--fe-panel)" }}>
        <span className="font-bold">サーバー（FactorEye）</span>
        <span className="font-num text-[11px] text-gray-500">
          センサー {sensors.data.length}&emsp;最新の受信 {newest === 0 ? "---" : formatAge(now - newest)}
        </span>
      </div>
      <div className="mx-auto h-3 w-0.5" style={{ background: "var(--fe-ok)" }} aria-hidden="true" />
      <div className="relative px-[1%]" role="presentation">
        <div className="h-0.5" style={{ background: "var(--fe-ok)", marginLeft: "-1%", marginRight: "-1%" }} aria-hidden="true" />
        <ul className="grid gap-2" style={{ gridTemplateColumns: `repeat(${strips.length}, minmax(0, 1fr))` }}>
          {strips.map((strip) => (
            <li key={strip.key} className="flex flex-col items-center">
              <Branch strip={strip} />
              <div
                className="w-full min-w-0 rounded-sm border px-2 py-1.5"
                style={{ borderColor: strip.state === "normal" ? "var(--fe-line)" : LINE_COLOR[strip.state], background: "var(--fe-panel)" }}
              >
                <p className="truncate font-bold" style={{ color: strip.state === "normal" || strip.state === "never" ? undefined : LINE_COLOR[strip.state] }} title={strip.title}>
                  {strip.title}
                </p>
                <p className="truncate font-num text-[11px] text-gray-500">{strip.lastTime === null ? "未受信" : formatAge(now - strip.lastTime)}</p>
                {strip.reason && strip.state !== "never" && (
                  <p className="truncate text-[11px]" style={{ color: LINE_COLOR[strip.state] }}>
                    {strip.reason}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** サーバーから機器への線。受信＝緑の実線、注意＝橙の破線、警報＝赤の実線、未受信＝灰色の点線 */
function Branch({ strip }: { strip: Strip }) {
  const style = strip.state === "never" ? "dotted" : strip.state === "warning" ? "dashed" : "solid";
  return <span className="h-3" style={{ borderLeft: `2px ${style} ${LINE_COLOR[strip.state]}` }} aria-hidden="true" />;
}
