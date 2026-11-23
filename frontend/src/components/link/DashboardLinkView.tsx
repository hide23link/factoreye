/**
 * リンク（/?dashboard=…&range=…m。graph なし）で開いた、ダッシュボード全体の 1 画面。
 * ダッシュボードの部品を、置いた順に縦 1 列で並べる（数値・メーターなど小さいものは縦向きで 2 列、横向きは全体を 2 列）。
 * 出す部品の決まりは lib/dashboard-link.ts。平面図・機器の系統図などは出さない。
 *
 * 期間は上の固定帯（sticky）に 1 つだけ持ち、全グラフ共通。ボタン（10 分〜24 時間）・「＋」「－」（1 段ずつ拡大・縮小）・
 * 🕘（時刻の指定。LinkTimeSheet）・「今に戻る」。指で変えた期間は保存しない（LinkScreen と同じ。ダッシュボードの期間は通さない）。
 * 取得の期間は、指を離して 0.3 秒たってから表示に合わせる（useSettledPeriod）。グラフの取得は、まとめ取得（downsample-batcher）で要求数を抑える。
 *
 * 指の操作（touch-action: pan-y）: 縦=ブラウザのスクロール／横ドラッグ=全グラフの時間移動／2 本指ピンチ=全グラフの拡大・縮小／
 * タップ=全グラフに同じ時刻の線と値／ダブルタップ=リンクの設定に戻す（useLinkGestures の scrollY）。
 * グラフのカードの「⤢」で、そのグラフ 1 つの画面（LinkScreen）へ。「戻る」（画面の戻るボタンも）で一覧へ。URL は変えない。
 *
 * 【誰が使うか】GraphLinkView（リンクで開いたとき）、GraphLinkDialog（開いたときの画面の小さな見本）。
 * 【引数（props）】dashboard = 開くダッシュボード、rangeMinutes = リンクの「直近 ◯ 分」、
 * preview = 見本のとき true（指の操作・時刻の指定・ボタンを止め、先頭の数個だけ出す）。
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useLatestReadings, useSensors } from "../../hooks/queries";
import { useElementSize } from "../../hooks/useElementSize";
import { useLinkGestures } from "../../hooks/useLinkGestures";
import { useLinkRows, useSettledPeriod, useToast } from "../../hooks/useLinkView";
import { useLiveNow } from "../../hooks/useLiveNow";
import { LinkRangeContext } from "../../hooks/useWidgetRange";
import { graphColor, graphSensorIds } from "../../lib/graph-config";
import { graphName, isGraphWidget } from "../../lib/graph-link";
import { VALUE_TILE_LIMIT, isSmallListWidget, listHeightCss, listWidgets, valueTiles, type GraphSize, type ValueTile } from "../../lib/dashboard-link";
import { classifySeverity } from "../../lib/severity";
import { useRefreshStore } from "../../store/useRefreshStore";
import { nearestValue } from "../../lib/graph-series";
import {
  DEFAULT_PICKED_MINUTES,
  LINK_LIST_CHIPS_MINUTES,
  chipPeriod,
  clockText,
  dateText,
  durationText,
  isAtLink,
  isChipActive,
  jumpText,
  linkPeriod,
  periodBounds,
  periodLabel,
  segText,
  startAtPeriod,
  stepZoom,
  type LinkPeriod,
} from "../../lib/link-range";
import { maxRangeForBuild } from "../../lib/timeRange";
import type { DashboardDetail, Sensor, Widget } from "../../types";
import { AlarmAlertWidget } from "../widgets/AlarmAlertWidget";
import { DeviceTreeWidget } from "../widgets/DeviceTreeWidget";
import { FloorPlanWidget } from "../widgets/FloorPlanWidget";
import { GaugeWidget } from "../widgets/GaugeWidget";
import { formatYTick, type LinkGraphView } from "../widgets/graph-parts";
import { MultiSensorComparisonWidget } from "../widgets/MultiSensorComparisonWidget";
import { ProductionPlanWidget } from "../widgets/ProductionPlanWidget";
import { ProductionStatusWidget } from "../widgets/ProductionStatusWidget";
import { SensorGraphWidget } from "../widgets/SensorGraphWidget";
import { StateTimelineWidget } from "../widgets/StateTimelineWidget";
import { StatValueWidget } from "../widgets/StatValueWidget";
import { TapeGaugeWidget } from "../widgets/TapeGaugeWidget";
import { TargetStripWidget } from "../widgets/TargetStripWidget";
import { TrendStackWidget } from "../widgets/TrendStackWidget";
import { LinkScreen } from "./LinkScreen";
import { LinkTimeSheet } from "./LinkTimeSheet";

/**
 * 「今」を進める間隔（30 秒）。一覧では、グラフごとの設定の間隔（refreshSeconds）は使わず、全グラフで 30 秒に固定する
 * （画面の更新間隔の選択 useRefreshStore には従う）。
 *
 * 要求数の目安: グラフは、同じ範囲・同じセンサーの取得をまとめ API（downsample-batcher）で束ねるので、1 回の更新で POST 数回（グラフが多くても 50 件ずつ）。
 * 一方、小さい部品（数値・メーター・計器・稼働ステータス）は、既存のウィジェットを再利用しているため、部品ごとに 5 秒間隔で個別に取る（まとめ取得は使っていない）。
 * 要求数は部品の数に比例し、例えば小さい部品 20 個なら 5 秒あたり約 20 回（毎秒 4 回前後。稼働ステータスは集計の取得が 2 本増える）。
 * これを減らすには、小さい部品の取得も まとめ API に寄せる改修が要る（ウィジェットの取得の作りを変えるため、今回は見送り）。
 */
const LIVE_REFRESH_MS = 30_000;
/** 固定の帯の高さを入れる CSS 変数（カードの高さの計算に使う） */
const HEADER_VAR = "--link-hdr";
/** 帯の高さを測れる前（初回の描画）の仮の高さ（px） */
const HEADER_FALLBACK_PX = 140;
/** 横向きで先頭に出すタイルの数（1 行） */
const LANDSCAPE_TILE_LIMIT = 4;
/** 見本（preview）に出す部品の数 */
const PREVIEW_COUNT = 4;
/** 指を置いても指の操作にしない所（ボタンの押下を奪わないため） */
const NO_GESTURE = "[data-no-gesture]";
/** 位置を測るグラフの枠 */
const GRAPH_BOX = "[data-link-graph]";

/** 一覧のカードの中身（部品の種類で選ぶ。グラフだけ、全グラフ共通の期間 linkView で描く） */
function ListWidgetBody({ widget, linkView }: { widget: Widget; linkView: LinkGraphView }) {
  switch (widget.type) {
    case "SensorGraph":
      return <SensorGraphWidget widget={widget} linkView={linkView} />;
    case "MultiSensorComparison":
      return <MultiSensorComparisonWidget widget={widget} linkView={linkView} />;
    case "StatValue":
      return <StatValueWidget widget={widget} />;
    case "Gauge":
      return <GaugeWidget widget={widget} />;
    case "TapeGauge":
      return <TapeGaugeWidget widget={widget} />;
    case "ProductionStatus":
      return <ProductionStatusWidget widget={widget} />;
    case "AlarmAlert":
      return <AlarmAlertWidget />;
    // 期間で動く 3 つは、LinkRangeContext（共通の期間）で動く。期間と関係ない 3 つは、そのまま出す
    case "TrendStack":
      return <TrendStackWidget widget={widget} />;
    case "StateTimeline":
      return <StateTimelineWidget widget={widget} />;
    case "TargetStrip":
      return <TargetStripWidget widget={widget} />;
    case "ProductionPlan":
      return <ProductionPlanWidget widget={widget} />;
    case "FloorPlan":
      return <FloorPlanWidget widget={widget} />;
    case "DeviceTree":
      return <DeviceTreeWidget />;
    default:
      return null;
  }
}

/** グラフのカード。名前・⤢・今の値（タップした時刻があればその時刻の値）・グラフ */
function GraphCard({
  widget,
  sensors,
  linkView,
  preview,
  onOpen,
}: {
  widget: Widget;
  sensors: Sensor[] | undefined;
  linkView: LinkGraphView;
  preview: boolean;
  onOpen: () => void;
}) {
  const { rows } = useLinkRows(widget, linkView.fetchBounds, linkView.live);
  const valueAt = linkView.cursorTime ?? linkView.bounds.to;
  const nameOf = (id: string) => widget.config.seriesNames?.[id]?.trim() || sensors?.find((s) => s.id === id)?.name || id;
  return (
    <>
      {/* 見出し: 名前（太字）＋⤢。淡い背景の帯に下線 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-300 bg-gray-100 pl-3 pr-1">
        <b className="min-w-0 truncate text-sm" title={graphName(widget, sensors)}>
          {graphName(widget, sensors)}
        </b>
        <button
          type="button"
          data-no-gesture
          disabled={preview}
          aria-label={`${graphName(widget, sensors)} を 1 画面で開く`}
          onClick={onOpen}
          className="min-h-9 min-w-9 shrink-0 rounded-full text-base text-gray-500"
        >
          ⤢
        </button>
      </div>
      {/* 凡例: 色・名前・今の値（タップした時刻があれば、その時刻の値） */}
      <div className="flex min-h-5 shrink-0 flex-wrap gap-x-3 px-3 pt-1 text-xs text-gray-500">
        {graphSensorIds(widget).map((id, i) => {
          const value = nearestValue(rows, id, valueAt);
          return (
            <span key={id}>
              <i aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm align-[1px]" style={{ background: graphColor(widget, i) }} />
              {nameOf(id)} {sensors?.find((s) => s.id === id)?.unit ?? ""}{" "}
              <b className="text-sm text-gray-900">{value === null ? "—" : formatYTick(value)}</b>
            </span>
          );
        })}
        {linkView.cursorTime !== null && linkView.cursorTime !== undefined && <span>{clockText(linkView.cursorTime)} の値</span>}
      </div>
      {/* グラフは、左右の余白を詰めて幅いっぱい */}
      <div data-link-graph className="relative min-h-0 flex-1 px-0.5 [&_:focus]:outline-none">
        <ListWidgetBody widget={widget} linkView={linkView} />
      </div>
    </>
  );
}

/**
 * 先頭の「今の値」タイル（2 列）。小さい名前（2 行まで）・大きい数字（右寄せ・下線・単位）。しきい値を超えていれば橙・赤。
 * 先頭 VALUE_TILE_LIMIT 個まで。残りは「ほか N 個の値を見る」で開く。タップで、そのグラフのカードへスクロールする。
 * 値は全センサーの最新値の取得（useLatestReadings。1 回の取得）を使う。グラフの取得は増やさない。
 */
/** 横向きか（向きが変わったら追いかける。matchMedia が無い環境では縦向き） */
function useLandscape(): boolean {
  const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(orientation: landscape)") : null;
  const [landscape, setLandscape] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const update = () => setLandscape(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [query]);
  return landscape;
}

function ValueTiles({ tiles, sensors, onPick }: { tiles: ValueTile[]; sensors: Sensor[] | undefined; onPick: (widgetId: string) => void }) {
  const { data } = useLatestReadings();
  const [expanded, setExpanded] = useState(false);
  // 横向きは高さが小さいので、先頭の 1 行（4 個）だけ。最初の画面にグラフが入るようにする
  const limit = useLandscape() ? LANDSCAPE_TILE_LIMIT : VALUE_TILE_LIMIT;
  if (tiles.length === 0) return null;
  const shown = expanded ? tiles : tiles.slice(0, limit);
  const hidden = tiles.length - limit;
  const severityColor = { critical: "text-red-600", warning: "text-amber-600", normal: "text-gray-900" } as const;
  return (
    <div role="group" aria-label="今の値" className="grid grid-cols-2 gap-x-3.5 gap-y-1.5 bg-white px-3.5 pb-2.5 pt-1 landscape:grid-cols-4 landscape:pb-1">
      {shown.map((tile) => {
        const reading = data?.readings.find((r) => r.sensorId === tile.sensorId);
        const sensor = sensors?.find((s) => s.id === tile.sensorId);
        const severity = reading && sensor ? classifySeverity(reading.value, sensor) : "normal";
        return (
          <button key={tile.sensorId} type="button" onClick={() => onPick(tile.widgetId)} className="min-w-0 text-left" aria-label={`${tile.name} へ移る`}>
            <span className="line-clamp-2 min-h-[2.3em] text-[11px] leading-tight text-gray-500 landscape:line-clamp-1 landscape:min-h-0">{tile.name}</span>
            <span className={`block border-b border-gray-300 text-right text-2xl font-bold leading-tight landscape:text-xl ${severityColor[severity]}`}>
              {reading ? formatYTick(reading.value) : "—"}
              <small className="ml-0.5 text-[11px] font-normal text-gray-500">{tile.unit}</small>
            </span>
          </button>
        );
      })}
      {hidden > 0 && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="col-span-2 min-h-8 text-center text-xs text-blue-600 landscape:col-span-4">
          {expanded ? "閉じる ▴" : `ほか ${hidden} 個の値を見る ▾`}
        </button>
      )}
    </div>
  );
}

/** 今の履歴の項目に付いた、1 グラフ表示の印（開いたグラフの ID）。無ければ null */
function linkFocusMark(): string | null {
  const mark = (window.history.state as { linkFocus?: unknown } | null)?.linkFocus;
  return typeof mark === "string" ? mark : null;
}

export function DashboardLinkView({
  dashboard,
  rangeMinutes,
  preview = false,
}: {
  dashboard: DashboardDetail;
  rangeMinutes: number;
  preview?: boolean;
}) {
  const { data: sensors } = useSensors();
  const now = useLiveNow(LIVE_REFRESH_MS);
  const [period, setPeriod] = useState<LinkPeriod>(() => linkPeriod(rangeMinutes));
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const [sheetOpenedAt, setSheetOpenedAt] = useState<number | null>(null);
  const [pickedMinutes, setPickedMinutes] = useState(DEFAULT_PICKED_MINUTES);
  // 1 グラフ表示に移っているグラフの ID（一覧のときは null）。期間は、移っている間も一覧が持つ
  const [focusId, setFocusId] = useState<string | null>(null);
  // グラフのカードの大きさ（半分 / 全画面）。選んでも保存しない。横向きは高さが小さいので全画面から始める
  const [size, setSize] = useState<GraphSize>(() =>
    typeof window.matchMedia === "function" && window.matchMedia("(orientation: landscape)").matches ? "full" : "half",
  );
  const headerRef = useRef<HTMLElement>(null);
  const { height: measuredHeader } = useElementSize(headerRef);
  const headerPx = measuredHeader > 0 ? measuredHeader : HEADER_FALLBACK_PX;
  const timeButton = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const maxMs = maxRangeForBuild();
  const bounds = periodBounds(period, now);
  const [holding, setHolding] = useState(false);
  const fetchPeriod = useSettledPeriod(period, holding);
  const fetchBounds = periodBounds(fetchPeriod, now);
  const fetchLive = fetchPeriod.endMs === null;
  const linkView: LinkGraphView = { bounds, fetchBounds, live: fetchLive, cursorTime, scrollY: true };
  // 期間で動くウィジェット（計器グラフ・状態の帯・達成ストリップ）に渡す共通の期間。指を離して決まる取得の範囲（値が同じなら同じオブジェクト）
  const linkRange = useMemo(() => ({ from: fetchBounds.from, to: fetchBounds.to }), [fetchBounds.from, fetchBounds.to]);

  // 全画面のときは、スクロールが 1 枚ずつ止まるようにする（html に付ける。近くまで来たら吸い付く proximity）
  useEffect(() => {
    if (preview || size !== "full") return;
    const root = document.documentElement;
    const before = root.style.scrollSnapType;
    root.style.scrollSnapType = "y proximity";
    return () => {
      root.style.scrollSnapType = before;
    };
  }, [preview, size]);
  // 1 グラフ表示へ移る前のスクロール位置。一覧に戻ったとき、同じ位置に戻す
  const scrollBeforeFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (focusId !== null || scrollBeforeFocus.current === null) return;
    window.scrollTo(0, scrollBeforeFocus.current);
    scrollBeforeFocus.current = null;
  }, [focusId]);
  // ページ全体のスクロールの端で、ブラウザの引っ張り更新・戻るの動きを起こさない（スクロールするのは html なので、そこに付ける。見本では付けない）
  useEffect(() => {
    if (preview) return;
    const root = document.documentElement;
    const before = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = "contain";
    return () => {
      root.style.overscrollBehaviorY = before;
    };
  }, [preview]);

  // 1 グラフ表示へ移るとき、履歴を 1 つ足す（URL は変えない）。画面の戻るボタンでも一覧へ戻れる
  const openFocus = (id: string) => {
    scrollBeforeFocus.current = window.scrollY;
    try {
      // 履歴の印には、開いたグラフの ID を入れる（印が今のグラフのものかを、戻るときに確かめるため）
      window.history.pushState({ linkFocus: id }, "", window.location.href);
    } catch {
      // 履歴を触れない環境（プレビューなど）でも、画面の切り替えはできる
    }
    setFocusId(id);
  };
  const closeFocus = () => {
    // 足した履歴があれば、戻る（popstate で一覧に戻る）。無ければ、そのまま一覧に戻す
    if (linkFocusMark() === focusId) window.history.back();
    else setFocusId(null);
  };
  useEffect(() => {
    if (preview) return;
    // 再読込のあとは、前の印が履歴に残っている（画面は一覧から始まる）。残すと、戻るで 1 グラフ画面に入り直してしまうので消す
    if (linkFocusMark() !== null) {
      try {
        window.history.replaceState(null, "", window.location.href);
      } catch {
        // 履歴を触れない環境では、そのまま
      }
    }
    // 戻る・進むで、履歴の印に画面を合わせる（印があればそのグラフ、無ければ一覧）
    const onPopState = () => setFocusId(linkFocusMark());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [preview]);

  const closeSheet = () => {
    setSheetOpenedAt(null);
    timeButton.current?.focus();
  };
  const backToLink = () => {
    setPeriod(linkPeriod(rangeMinutes));
    setCursorTime(null);
    toast.flash("リンクの設定に戻しました");
  };
  const changePeriod = (next: LinkPeriod) => {
    setPeriod(next);
    setCursorTime(null);
  };
  const applyStart = (startMs: number) => {
    const pressedAt = Date.now();
    const next = startAtPeriod(period, startMs, pressedAt, maxMs);
    if (!next) {
      toast.flash("まだ来ていない時刻です");
      return;
    }
    changePeriod(next);
    closeSheet();
    toast.flash(jumpText(next, startMs, pressedAt));
  };
  const gestures = useLinkGestures({
    period,
    now,
    maxMs,
    scrollY: true,
    disabled: sheetOpenedAt !== null,
    onChange: (next, zoomed) => {
      changePeriod(next);
      if (zoomed) toast.flash(durationText(next.durationMs));
    },
    onTap: (ratio) => setCursorTime(bounds.from + (bounds.to - bounds.from) * ratio),
    onDoubleTap: backToLink,
    onStart: () => setHolding(true),
    onEnd: () => setHolding(false),
    // 時間を測るのは、指を置いたグラフ（グラフ以外に置いたときは、先頭のグラフ）
    plotElement: (target, container) =>
      (target instanceof Element ? target.closest<HTMLElement>(GRAPH_BOX) : null) ?? container.querySelector<HTMLElement>(GRAPH_BOX) ?? container,
    ignoreTarget: (target) => target instanceof Element && target.closest(NO_GESTURE) !== null,
  });

  const queryClient = useQueryClient();
  const markManualRefresh = useRefreshStore((s) => s.markManualRefresh);

  const focused = focusId ? dashboard.widgets.find((w) => w.id === focusId && isGraphWidget(w)) : undefined;
  if (focused) {
    return (
      <div className="fixed inset-0 overscroll-none">
        <LinkScreen widget={focused} rangeMinutes={rangeMinutes} onBack={closeFocus} />
      </div>
    );
  }

  const widgets = listWidgets(dashboard.widgets).slice(0, preview ? PREVIEW_COUNT : undefined);
  const tiles = valueTiles(widgets, sensors);
  // 横向き（高さが小さい）のときは、帯を 1 行にする（見本は縦向きの形に固定）
  const compact = !preview;
  const toolButton = "min-h-8 shrink-0 rounded-full border px-3 text-xs";
  const live = period.endMs === null;
  // タイルのタップ: そのグラフのカードへスムーズにスクロールする（帯の下に止まる）
  const scrollToCard = (widgetId: string) => {
    document.querySelector(`[data-widget-id="${widgetId}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <LinkRangeContext.Provider value={linkRange}>
      <div
        className={`select-none bg-gray-50 text-gray-900 ${preview ? "h-full overflow-hidden" : "min-h-dvh"}`}
        // ブラウザの拡大・横のスクロールは止め、縦のスクロールだけ受ける（ピンチはこちらで処理する）
        style={{ touchAction: "pan-y", [HEADER_VAR]: `${headerPx}px` } as React.CSSProperties}
      >
        {/* 固定の帯: 青いヘッダー（名前＋更新）と、幅いっぱいの期間の分節ボタン。横向きは 1 行 */}
        <header ref={headerRef} className={`z-20 border-b border-gray-200 ${preview ? "" : "sticky top-0 landscape:flex landscape:items-stretch"}`}>
          <div
            className={`flex items-center justify-between gap-2 bg-blue-600 pb-1.5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-3 pt-[max(0.375rem,env(safe-area-inset-top))] text-white ${
              compact ? "landscape:w-[30%] landscape:shrink-0 landscape:py-1" : ""
            }`}
          >
            <b className="min-w-0 truncate text-base" title={dashboard.name}>
              {dashboard.name}
            </b>
            <button
              type="button"
              aria-label="更新"
              disabled={preview}
              onClick={() => {
                markManualRefresh();
                void queryClient.invalidateQueries();
              }}
              className="flex min-h-8 shrink-0 items-center gap-1 rounded px-1 text-xs"
            >
              <span aria-hidden="true" className="text-lg">↻</span>更新
            </button>
          </div>
          <div className={`bg-white pr-[max(0.625rem,env(safe-area-inset-right))] ${compact ? "landscape:flex landscape:min-w-0 landscape:flex-1 landscape:items-center landscape:gap-2" : ""}`}>
            <div
              role="group"
              aria-label="期間"
              className={`flex gap-1.5 pb-0.5 pl-2.5 pr-0 pt-2 ${compact ? "landscape:flex-1 landscape:py-1" : ""}`}
            >
              {LINK_LIST_CHIPS_MINUTES.map((minutes) => {
                const active = isChipActive(period, minutes);
                return (
                  <button
                    key={minutes}
                    type="button"
                    disabled={preview}
                    aria-pressed={active}
                    onClick={() => changePeriod(chipPeriod(period, minutes, now, maxMs))}
                    className={`min-h-10 min-w-0 flex-1 rounded-md px-0 text-xs ${compact ? "landscape:min-h-8" : ""} ${
                      active ? "bg-blue-600 font-bold text-white" : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {segText(minutes)}
                  </button>
                );
              })}
            </div>
            <div className="flex min-h-8 items-center justify-between gap-1.5 pl-2.5 text-xs text-gray-500">
              <span className={`flex-1 text-center ${compact ? "landscape:hidden" : ""}`}>
                {/* リンクの長さがどのボタンにも合わないとき（例: 30 分）は、長さを青く強調して、今の選択が分かるようにする */}
                {!LINK_LIST_CHIPS_MINUTES.some((m) => isChipActive(period, m)) && <b className="mr-1.5 text-blue-600">{periodLabel(period, now)}</b>}〜 {dateText(bounds.to)}
              </span>
              {!isAtLink(period, rangeMinutes) && !preview && (
                <button
                  type="button"
                  onClick={backToLink}
                  className="min-h-8 shrink-0 rounded-full border border-blue-600 bg-blue-50 px-2.5 text-xs font-bold text-blue-600"
                >
                  今に戻る
                </button>
              )}
            </div>
          </div>
        </header>
        {/* 今の時刻（過去を見ているときは、その期間）の灰色の帯 */}
        <p className="mx-2.5 mb-1 mt-2 rounded-sm bg-gray-200 py-0.5 text-center text-xs text-gray-600">
          {live ? `${dateText(now)} 現在` : `${dateText(bounds.from)} 〜 ${dateText(bounds.to)}`}
        </p>
        {!preview && <ValueTiles tiles={tiles} sensors={sensors} onPick={scrollToCard} />}
        {/* 操作の段（スクロールで流れる）: －／＋・時刻の指定・半分／全画面 */}
        <div className="flex gap-1.5 overflow-x-auto bg-white px-2.5 pb-2 pt-1">
          <button type="button" aria-label="縮小（期間を 2 倍にする）" disabled={preview} onClick={() => changePeriod(stepZoom(period, "out", now, maxMs))} className={`${toolButton} min-w-9 border-gray-200 bg-white text-sm font-bold`}>
            －
          </button>
          <button type="button" aria-label="拡大（期間を半分にする）" disabled={preview} onClick={() => changePeriod(stepZoom(period, "in", now, maxMs))} className={`${toolButton} min-w-9 border-gray-200 bg-white text-sm font-bold`}>
            ＋
          </button>
          <button
            type="button"
            ref={timeButton}
            aria-label="時刻を指定"
            disabled={preview}
            onClick={() => setSheetOpenedAt(Date.now())}
            className={`${toolButton} flex items-center gap-1 border-gray-200 text-gray-600`}
          >
            {periodLabel(period, now)} 🕘
          </button>
          <div role="group" aria-label="グラフの大きさ" className="ml-auto flex shrink-0 gap-1">
            {(["half", "full"] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={preview}
                aria-pressed={size === choice}
                onClick={() => setSize(choice)}
                className={`${toolButton} ${size === choice ? "border-blue-600 font-bold text-blue-600" : "border-gray-200 bg-white text-gray-600"}`}
              >
                {choice === "half" ? "半分" : "全画面"}
              </button>
            ))}
          </div>
        </div>
        <div
          ref={preview ? undefined : gestures.ref}
          {...(preview ? {} : gestures.handlers)}
          className="mt-1.5 grid grid-cols-2 content-start gap-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        >
          {widgets.length === 0 && <p className="col-span-2 p-4 text-center text-sm text-gray-500">このダッシュボードには、表示できる部品がありません。</p>}
          {widgets.map((widget) => {
            const graph = isGraphWidget(widget);
            const small = isSmallListWidget(widget);
            const treeFrame = widget.type === "DeviceTree";
            // 小さい部品は縦向きで 2 列、それ以外は 1 列を使い切る。横向きは、すべて 2 列（見本は縦向きの形に固定）
            const span = small ? "" : preview ? "col-span-2" : "col-span-2 landscape:col-span-1";
            // グラフ・大きい部品は幅いっぱい（左右の枠・角丸なし）。小さい部品は左右に余白
            const shape = small ? "mx-2 rounded-lg border p-2" : graph ? "border-y p-0" : "border-y p-2";
            const title = widget.config.title?.trim();
            return (
              <section
                key={widget.id}
                data-widget-id={widget.id}
                aria-label={graphName(widget, sensors)}
                // 部品の中の、スクロールできる要素（overflow を持つ要素）も pan-y にする。touch-action は、触れた要素から最も近いスクロール容器までしか祖先と合成されないため、
                // 中の要素が auto だと、横ドラッグをブラウザが横取りして pointercancel になる（インラインの指定にも勝つよう !important）。
                // 機器の系統図は、枠が横にスクロールできるので pan-x も許し、その枠への指は期間の移動に渡さない（data-no-gesture）
                {...(treeFrame ? { "data-no-gesture": "" } : {})}
                className={`flex flex-col overflow-hidden border-gray-200 bg-white ${shape} ${span} ${
                  treeFrame ? "[&_*]:!touch-pan-x [&_*]:!touch-pan-y" : "[&_*]:!touch-pan-y"
                }`}
                style={{
                  height: listHeightCss(widget, size, HEADER_VAR, preview),
                  // スクロールで止まる位置は、帯の下（タイルのタップ・全画面のスナップ）
                  scrollMarginTop: `${headerPx}px`,
                  ...(graph && size === "full" && !preview ? { scrollSnapAlign: "start" } : {}),
                }}
              >
                {graph ? (
                  <GraphCard widget={widget} sensors={sensors} linkView={linkView} preview={preview} onOpen={() => openFocus(widget.id)} />
                ) : (
                  <>
                    {title && (
                      <p className="mb-1 shrink-0 truncate text-xs font-semibold text-gray-500" title={title}>
                        {title}
                      </p>
                    )}
                    <div className="min-h-0 flex-1 overflow-hidden">
                      <ListWidgetBody widget={widget} linkView={linkView} />
                    </div>
                  </>
                )}
              </section>
            );
          })}
        </div>
        {toast.message && (
          <div className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full bg-gray-900 px-3 py-1 text-xs text-white">
            {toast.message}
          </div>
        )}
        {sheetOpenedAt !== null && (
          <LinkTimeSheet now={sheetOpenedAt} maxMs={maxMs} pickedMinutes={pickedMinutes} onPick={setPickedMinutes} onJump={applyStart} onClose={closeSheet} />
        )}
      </div>
    </LinkRangeContext.Provider>
  );
}
