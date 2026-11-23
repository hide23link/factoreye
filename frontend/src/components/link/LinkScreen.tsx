/**
 * リンクで開いたグラフ 1 つの画面（上: グラフ名・期間・今の値、中: グラフ、下: 期間のボタン・状態の行）。
 *
 * グラフは、ダッシュボードと同じウィジェット（SensorGraphWidget・MultiSensorComparisonWidget）で描く（線・色・縦軸が同じ）。
 * 期間はこの画面の中だけで持つ（lib/link-range.ts）。ダッシュボードの期間（useTimeRangeStore）を通さないので、
 * 端末に覚えた期間・URL では上書きせず、指で変えた期間も保存しない。今を見ている間は、グラフの設定の間隔で自動更新する。
 * 期間は 2 つ持つ: 表示の期間（指に合わせて毎回変わる）と、取得の期間（指を離して 0.3 秒たってから表示に合わせる）。
 * 指を動かすたびに読み値を取り直すと、サーバーへの要求が 1 秒に何十回にもなるため。
 *
 * 【誰が使うか】GraphLinkView（リンクで開いたとき。画面いっぱい）、GraphLinkDialog（開いたときの画面の小さな見本）、
 * DashboardLinkView（ダッシュボード全体の一覧から、カードの ⤢ で 1 グラフを開くとき）。
 * 【引数（props）】widget = 出すグラフのウィジェット、rangeMinutes = リンクの「直近 ◯ 分」、
 * preview = 見本のとき true（指の操作・時刻の指定・ボタンを止める）、
 * onBack = 一覧から開いたときだけ渡す（左下に丸い「戻る」を浮かべ、押すと一覧へ戻る）。
 * 時刻の指定のシート（LinkTimeSheet）を開いている間も、グラフの指の操作は受けない（シートの操作とぶつからないように）。
 */
import { useRef, useState } from "react";

import { useSensors } from "../../hooks/queries";
import { useLinkGestures } from "../../hooks/useLinkGestures";
import { useLinkRows, useSettledPeriod, useToast } from "../../hooks/useLinkView";
import { useLiveNow } from "../../hooks/useLiveNow";
import { graphColor, graphDataOptions, graphSensorIds } from "../../lib/graph-config";
import { graphName } from "../../lib/graph-link";
import { nearestValue } from "../../lib/graph-series";
import {
  DEFAULT_PICKED_MINUTES,
  LINK_CHIPS_MINUTES,
  chipPeriod,
  chipText,
  clockText,
  durationText,
  isAtLink,
  isChipActive,
  jumpText,
  linkPeriod,
  periodBounds,
  periodLabel,
  startAtPeriod,
  statusText,
  type LinkPeriod,
} from "../../lib/link-range";
import { maxRangeForBuild } from "../../lib/timeRange";
import type { Widget } from "../../types";
import { formatYTick } from "../widgets/graph-parts";
import { MultiSensorComparisonWidget } from "../widgets/MultiSensorComparisonWidget";
import { SensorGraphWidget } from "../widgets/SensorGraphWidget";
import { LinkTimeSheet } from "./LinkTimeSheet";

export function LinkScreen({
  widget,
  rangeMinutes,
  preview = false,
  onBack,
}: {
  widget: Widget;
  rangeMinutes: number;
  preview?: boolean;
  onBack?: () => void;
}) {
  const { data: sensors } = useSensors();
  const sensorIds = graphSensorIds(widget);
  const options = graphDataOptions(widget.config, sensorIds.length);
  // 今を見ている間は、グラフの設定の間隔（既定 30 秒）ごとに範囲を進める（ダッシュボードのグラフと同じ）
  const now = useLiveNow(options.refreshMs);
  const [period, setPeriod] = useState<LinkPeriod>(() => linkPeriod(rangeMinutes));
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  // 時刻の指定のシートを開いた時刻（閉じているときは null）。近道・押せる日は、この時刻で決める
  const [sheetOpenedAt, setSheetOpenedAt] = useState<number | null>(null);
  // シートの ① で選んだ時刻（0:00 からの分）。閉じても覚えておき、次に開いたときもそのまま
  const [pickedMinutes, setPickedMinutes] = useState(DEFAULT_PICKED_MINUTES);
  // 閉じたら 🕘 へフォーカスを戻す（キーボード・読み上げで、元の場所から続けられるように）
  const timeButton = useRef<HTMLButtonElement>(null);
  const closeSheet = () => {
    setSheetOpenedAt(null);
    timeButton.current?.focus();
  };
  const toast = useToast();
  const maxMs = maxRangeForBuild();
  const bounds = periodBounds(period, now);
  // 指を置いている間は、取得の期間を変えない（表示だけを動かす）
  const [holding, setHolding] = useState(false);
  const fetchPeriod = useSettledPeriod(period, holding);
  const fetchBounds = periodBounds(fetchPeriod, now);
  const fetchLive = fetchPeriod.endMs === null;
  const { rows, updatedAt } = useLinkRows(widget, fetchBounds, fetchLive);

  const backToLink = () => {
    setPeriod(linkPeriod(rangeMinutes));
    setCursorTime(null);
    toast.flash("リンクの設定に戻しました");
  };
  const gestures = useLinkGestures({
    period,
    now,
    maxMs,
    // シートを開いている間は、グラフの指の操作を受けない（ハンドラーは外さない。離した知らせは受けるため）
    disabled: sheetOpenedAt !== null,
    onChange: (next, zoomed) => {
      setPeriod(next);
      setCursorTime(null);
      if (zoomed) toast.flash(durationText(next.durationMs));
    },
    onTap: (ratio) => setCursorTime(bounds.from + (bounds.to - bounds.from) * ratio),
    onDoubleTap: backToLink,
    onStart: () => setHolding(true),
    onEnd: () => setHolding(false),
  });
  const applyStart = (startMs: number) => {
    // シートを開いたままの間に時刻が進んでも、未来へは移らない（念のため、押した時刻で確かめる）
    const pressedAt = Date.now();
    const next = startAtPeriod(period, startMs, pressedAt, maxMs);
    if (!next) {
      toast.flash("まだ来ていない時刻です");
      return;
    }
    setPeriod(next);
    setCursorTime(null);
    closeSheet();
    // 開始＋長さが今を越えると、今まで（直近 ◯）の表示になる。知らせも実際の表示に合わせる
    toast.flash(jumpText(next, startMs, pressedAt));
  };

  const valueAt = cursorTime ?? bounds.to;
  const linkView = { bounds, fetchBounds, live: fetchLive, cursorTime };
  const unitOf = (id: string) => sensors?.find((s) => s.id === id)?.unit ?? "";
  const nameOf = (id: string) => widget.config.seriesNames?.[id]?.trim() || sensors?.find((s) => s.id === id)?.name || id;

  return (
    <div className="relative flex h-full select-none flex-col bg-white text-gray-900">
      <div className="flex items-baseline justify-between gap-2 px-3 pb-0.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <b className="min-w-0 flex-1 truncate text-sm" title={graphName(widget, sensors)}>{graphName(widget, sensors)}</b>
        <button
          type="button"
          ref={timeButton}
          aria-label="時刻を指定"
          disabled={preview}
          onClick={() => setSheetOpenedAt(Date.now())}
          className="flex shrink-0 items-center gap-1 rounded-full border border-gray-200 px-2 text-xs tabular-nums text-gray-500"
        >
          {periodLabel(period, now)} 🕘
        </button>
      </div>
      <div className="flex min-h-6 flex-wrap gap-3 px-3 pb-1 pt-0.5 text-xs text-gray-500">
        {sensorIds.map((id, i) => {
          const value = nearestValue(rows, id, valueAt);
          return (
            <span key={id}>
              <i aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm align-[1px]" style={{ background: graphColor(widget, i) }} />
              {nameOf(id)} {unitOf(id)} <b className="text-base tabular-nums text-gray-900">{value === null ? "—" : formatYTick(value)}</b>
            </span>
          );
        })}
        {cursorTime !== null && <span>{clockText(cursorTime)} の値</span>}
      </div>
      <div
        ref={preview ? undefined : gestures.ref}
        {...(preview ? {} : gestures.handlers)}
        aria-label="グラフ。上下になぞると拡大・縮小、左右になぞると時間を動かす"
        // タップでグラフ（recharts）に付く、フォーカスの枠は出さない（タップは時刻の値を出す操作のため）
        className="relative min-h-0 flex-1 cursor-grab px-1.5 active:cursor-grabbing [&_:focus]:outline-none"
        style={{ touchAction: "none" }}
      >
        {widget.type === "MultiSensorComparison" ? (
          <MultiSensorComparisonWidget widget={widget} linkView={linkView} />
        ) : (
          <SensorGraphWidget widget={widget} linkView={linkView} />
        )}
        {toast.message && (
          <div className="pointer-events-none absolute left-1/2 top-2.5 -translate-x-1/2 whitespace-nowrap rounded-full bg-gray-900 px-2.5 py-0.5 text-xs text-white">
            {toast.message}
          </div>
        )}
      </div>
      <div role="group" aria-label="期間" className="flex gap-1.5 overflow-x-auto px-2.5 py-2">
        {LINK_CHIPS_MINUTES.map((minutes) => {
          const active = isChipActive(period, minutes);
          return (
            <button
              key={minutes}
              type="button"
              disabled={preview}
              aria-pressed={active}
              onClick={() => {
                setPeriod(chipPeriod(period, minutes, now, maxMs));
                setCursorTime(null);
              }}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs ${active ? "border-blue-600 bg-blue-600 font-bold text-white" : "border-gray-200 bg-white"}`}
            >
              {chipText(minutes)}
            </button>
          );
        })}
      </div>
      <div className="flex min-h-9 items-center justify-between gap-1.5 px-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-xs text-gray-500">
        <span>{statusText(period, now, updatedAt || now)}</span>
        {!isAtLink(period, rangeMinutes) && !preview && (
          <button
            type="button"
            onClick={backToLink}
            className="rounded-full border border-blue-600 bg-blue-50 px-2.5 py-0.5 text-xs font-bold text-blue-600"
          >
            今に戻る
          </button>
        )}
      </div>
      {onBack && (
        // 親指が届く左下の丸い「戻る」（一覧から開いたときだけ）。下の期間のボタン・状態の行の上に浮かべる
        <button
          type="button"
          aria-label="一覧に戻る"
          onClick={onBack}
          className="absolute left-[max(0.75rem,env(safe-area-inset-left))] bottom-[calc(10rem+env(safe-area-inset-bottom))] z-10 flex h-11 w-11 items-center justify-center rounded-full text-2xl leading-none shadow-md"
          // 明るい・暗いのどちらでも同じ（半透明の濃い丸に白い矢印）
          style={{ background: "rgba(17, 24, 39, 0.7)", color: "#fff" }}
        >
          ‹
        </button>
      )}
      {sheetOpenedAt !== null && (
        <LinkTimeSheet
          now={sheetOpenedAt}
          maxMs={maxMs}
          pickedMinutes={pickedMinutes}
          onPick={setPickedMinutes}
          onJump={applyStart}
          onClose={closeSheet}
        />
      )}
    </div>
  );
}
