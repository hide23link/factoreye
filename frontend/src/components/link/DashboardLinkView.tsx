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
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useSensors } from "../../hooks/queries";
import { useLinkGestures } from "../../hooks/useLinkGestures";
import { useLinkRows, useSettledPeriod, useToast } from "../../hooks/useLinkView";
import { useLiveNow } from "../../hooks/useLiveNow";
import { graphColor, graphSensorIds } from "../../lib/graph-config";
import { graphName, isGraphWidget } from "../../lib/graph-link";
import { listHeightPx, isSmallListWidget, listWidgets } from "../../lib/dashboard-link";
import { nearestValue } from "../../lib/graph-series";
import {
  DEFAULT_PICKED_MINUTES,
  LINK_LIST_CHIPS_MINUTES,
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
  stepZoom,
  type LinkPeriod,
} from "../../lib/link-range";
import { maxRangeForBuild } from "../../lib/timeRange";
import type { DashboardDetail, Sensor, Widget } from "../../types";
import { AlarmAlertWidget } from "../widgets/AlarmAlertWidget";
import { GaugeWidget } from "../widgets/GaugeWidget";
import { formatYTick, type LinkGraphView } from "../widgets/graph-parts";
import { MultiSensorComparisonWidget } from "../widgets/MultiSensorComparisonWidget";
import { ProductionStatusWidget } from "../widgets/ProductionStatusWidget";
import { SensorGraphWidget } from "../widgets/SensorGraphWidget";
import { StatValueWidget } from "../widgets/StatValueWidget";
import { TapeGaugeWidget } from "../widgets/TapeGaugeWidget";
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
      <div className="flex items-center justify-between gap-2">
        <b className="min-w-0 truncate text-xs text-gray-500" title={graphName(widget, sensors)}>{graphName(widget, sensors)}</b>
        <button
          type="button"
          data-no-gesture
          disabled={preview}
          aria-label={`${graphName(widget, sensors)} を 1 画面で開く`}
          onClick={onOpen}
          className="min-h-8 min-w-8 shrink-0 rounded-full text-sm text-gray-500"
        >
          ⤢
        </button>
      </div>
      <div className="flex min-h-5 flex-wrap gap-x-3 text-xs text-gray-500">
        {graphSensorIds(widget).map((id, i) => {
          const value = nearestValue(rows, id, valueAt);
          return (
            <span key={id}>
              <i aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm align-[1px]" style={{ background: graphColor(widget, i) }} />
              {nameOf(id)} {sensors?.find((s) => s.id === id)?.unit ?? ""}{" "}
              <b className="text-base tabular-nums text-gray-900">{value === null ? "—" : formatYTick(value)}</b>
            </span>
          );
        })}
        {linkView.cursorTime !== null && linkView.cursorTime !== undefined && <span>{clockText(linkView.cursorTime)} の値</span>}
      </div>
      <div data-link-graph className="relative min-h-0 flex-1 [&_:focus]:outline-none">
        <ListWidgetBody widget={widget} linkView={linkView} />
      </div>
    </>
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
  const timeButton = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const maxMs = maxRangeForBuild();
  const bounds = periodBounds(period, now);
  const [holding, setHolding] = useState(false);
  const fetchPeriod = useSettledPeriod(period, holding);
  const fetchBounds = periodBounds(fetchPeriod, now);
  const fetchLive = fetchPeriod.endMs === null;
  const linkView: LinkGraphView = { bounds, fetchBounds, live: fetchLive, cursorTime, scrollY: true };

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

  const focused = focusId ? dashboard.widgets.find((w) => w.id === focusId && isGraphWidget(w)) : undefined;
  if (focused) {
    return (
      <div className="fixed inset-0 overscroll-none">
        <LinkScreen widget={focused} rangeMinutes={rangeMinutes} onBack={closeFocus} />
      </div>
    );
  }

  const widgets = listWidgets(dashboard.widgets).slice(0, preview ? PREVIEW_COUNT : undefined);
  // 横向き（高さが小さい）のときは、帯を 1 行にする（タイトル・期間のボタン・今に戻る・🕘 を並べる）。見本は縦向きの形に固定
  const compact = !preview;
  const stepButton = "min-h-8 min-w-9 shrink-0 rounded-full border border-gray-200 bg-white px-3 text-sm font-bold disabled:opacity-60";

  return (
    <div
      className={`select-none bg-gray-50 text-gray-900 ${preview ? "h-full overflow-hidden" : "min-h-dvh"}`}
      // ブラウザの拡大・横のスクロールは止め、縦のスクロールだけ受ける（ピンチはこちらで処理する）
      style={{ touchAction: "pan-y" }}
    >
      <header
        className={`z-20 border-b border-gray-200 bg-white pl-[max(0.625rem,env(safe-area-inset-left))] pb-1.5 pr-[max(0.625rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))] ${
          preview ? "" : "sticky top-0 landscape:flex landscape:items-center landscape:gap-2 landscape:pb-1 landscape:pt-[max(0.25rem,env(safe-area-inset-top))]"
        }`}
      >
        <div className={`flex items-center justify-between gap-2 ${compact ? "landscape:contents" : ""}`}>
          <b className={`min-w-0 truncate text-sm ${compact ? "landscape:order-1 landscape:max-w-[30%] landscape:shrink-0" : ""}`} title={dashboard.name}>{dashboard.name}</b>
          <button
            type="button"
            ref={timeButton}
            aria-label="時刻を指定"
            disabled={preview}
            onClick={() => setSheetOpenedAt(Date.now())}
            className={`flex min-h-8 shrink-0 items-center gap-1 rounded-full border border-gray-200 px-2.5 text-xs tabular-nums text-gray-500 ${compact ? "landscape:order-4" : ""}`}
          >
            {periodLabel(period, now)} 🕘
          </button>
        </div>
        <div role="group" aria-label="期間" className={`mt-1.5 flex gap-1.5 overflow-x-auto pb-0.5 ${compact ? "landscape:order-2 landscape:mt-0 landscape:min-w-0 landscape:flex-1 landscape:pb-0" : ""}`}>
          <button
            type="button"
            aria-label="縮小（期間を 2 倍にする）"
            disabled={preview}
            onClick={() => changePeriod(stepZoom(period, "out", now, maxMs))}
            className={stepButton}
          >
            －
          </button>
          <button
            type="button"
            aria-label="拡大（期間を半分にする）"
            disabled={preview}
            onClick={() => changePeriod(stepZoom(period, "in", now, maxMs))}
            className={stepButton}
          >
            ＋
          </button>
          {LINK_LIST_CHIPS_MINUTES.map((minutes) => {
            const active = isChipActive(period, minutes);
            return (
              <button
                key={minutes}
                type="button"
                disabled={preview}
                aria-pressed={active}
                onClick={() => changePeriod(chipPeriod(period, minutes, now, maxMs))}
                className={`min-h-8 shrink-0 rounded-full border px-3 text-xs ${active ? "border-blue-600 bg-blue-600 font-bold text-white" : "border-gray-200 bg-white"}`}
              >
                {chipText(minutes)}
              </button>
            );
          })}
        </div>
        <div className={`flex min-h-8 items-center justify-between gap-1.5 text-xs text-gray-500 ${compact ? "landscape:order-3 landscape:min-h-0 landscape:shrink-0" : ""}`}>
          <span className={compact ? "landscape:hidden" : ""}>{statusText(period, now, now)}</span>
          {!isAtLink(period, rangeMinutes) && !preview && (
            <button
              type="button"
              onClick={backToLink}
              className="min-h-8 rounded-full border border-blue-600 bg-blue-50 px-2.5 text-xs font-bold text-blue-600"
            >
              今に戻る
            </button>
          )}
        </div>
      </header>
      <div
        ref={preview ? undefined : gestures.ref}
        {...(preview ? {} : gestures.handlers)}
        className="grid grid-cols-2 content-start gap-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]"
      >
        {widgets.length === 0 && <p className="col-span-2 p-4 text-center text-sm text-gray-500">このダッシュボードには、表示できる部品がありません。</p>}
        {widgets.map((widget) => {
          // 小さい部品は縦向きで 2 列、それ以外は 1 列を使い切る。横向きは、すべて 2 列（見本は縦向きの形に固定）
          const span = isSmallListWidget(widget) ? "" : preview ? "col-span-2" : "col-span-2 landscape:col-span-1";
          const title = widget.config.title?.trim();
          return (
            <section
              key={widget.id}
              aria-label={graphName(widget, sensors)}
              className={`flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white p-2 ${span}`}
              style={{ height: listHeightPx(widget) }}
            >
              {isGraphWidget(widget) ? (
                <GraphCard widget={widget} sensors={sensors} linkView={linkView} preview={preview} onOpen={() => openFocus(widget.id)} />
              ) : (
                <>
                  {title && <p className="mb-1 shrink-0 truncate text-xs font-semibold text-gray-500" title={title}>{title}</p>}
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
  );
}
