/**
 * グラフの表示時間範囲を操作する部品（Grafana の時間ピッカーと同じ考え方）。
 *
 * - 前へ・後ろへ: 範囲の幅の分だけ動かす（固定モードになる）
 * - 今: 右端を現在時刻にして、直近モードに戻す
 * - ＋・－: 範囲の幅を半分・2 倍にする
 * - 期間: プリセット、または開始と終了を入力した任意の期間
 *
 * 【誰が使うか】DashboardView.tsx が、画面の上部に置く。引数（props）はない
 * （表示範囲は、useTimeRangeStore に直接読み書きする）。
 */
import { useState } from "react";

import { LIVE_CHART_INTERVAL_MS } from "../hooks/queries";
import { useNow } from "../hooks/useNow";
import {
  absoluteRange,
  describeRange,
  maxRangeMs,
  nowRange,
  PRESETS,
  panRange,
  resolveRange,
  zoomRange,
  type TimeRange,
} from "../lib/timeRange";
import { useTimeRangeStore } from "../store/useTimeRangeStore";

// ビルド時に決まる動作モード（.env の VITE_AUTH_MODE）。SaaS は保持期間（90 日）まで
const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

/** ミリ秒を、datetime-local の入力欄の書式（YYYY-MM-DDTHH:mm、ローカル時刻）にする */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 直近モードの幅に合うプリセットのキー。合わなければ null（固定や、プリセット外の幅） */
function presetKeyOf(range: TimeRange): string | null {
  if (range.mode !== "relative") return null;
  return PRESETS.find((p) => p.durationMs === range.durationMs)?.key ?? null;
}

export function TimeRangeControls() {
  const range = useTimeRangeStore((s) => s.range);
  const setRange = useTimeRangeStore((s) => s.setRange);
  // グラフと同じ間隔（30 秒）で更新する（短いと、グラフの描き直しが増えて見にくくなる）
  // 再描画の合図（30 秒ごと）。計算に使う時刻は、操作の時点の現在時刻にする
  useNow(LIVE_CHART_INTERVAL_MS);
  const now = Date.now();
  const maxMs = maxRangeMs(IS_MULTI_TENANT);
  const bounds = resolveRange(range, now);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const applyCustom = () => {
    const from = new Date(customFrom).getTime();
    const to = new Date(customTo).getTime();
    const next = absoluteRange(from, to);
    if (!next) {
      setError("終了は開始より後にしてください");
      return;
    }
    if (to - from > maxMs) {
      setError("表示できる期間は 90 日までです");
      return;
    }
    setError(null);
    setRange(next);
  };

  return (
    <div role="group" aria-label="表示時間の操作" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        aria-label="前へ"
        onClick={() => setRange(panRange(range, -1, now, maxMs))}
        className="min-h-10 rounded border border-gray-300 px-3 py-2 hover:bg-gray-100 sm:min-h-0 sm:px-2 sm:py-1"
      >
        ◀
      </button>
      <button
        type="button"
        aria-label="今に戻る"
        onClick={() => setRange(nowRange(range, now))}
        className="min-h-10 rounded border border-gray-300 px-3 py-2 hover:bg-gray-100 sm:min-h-0 sm:px-2 sm:py-1"
      >
        今
      </button>
      {range.mode === "relative" && (
        <button
          type="button"
          aria-label="一時停止"
          // 今の表示範囲を固定して、動きを止める（再開は「今」で、直近モードに戻す）
          onClick={() => setRange({ mode: "absolute", from: bounds.from, to: bounds.to })}
          className="min-h-10 rounded border border-gray-300 px-3 py-2 hover:bg-gray-100 sm:min-h-0 sm:px-2 sm:py-1"
        >
          一時停止
        </button>
      )}
      <button
        type="button"
        aria-label="後ろへ"
        onClick={() => setRange(panRange(range, 1, now, maxMs))}
        className="min-h-10 rounded border border-gray-300 px-3 py-2 hover:bg-gray-100 sm:min-h-0 sm:px-2 sm:py-1"
      >
        ▶
      </button>
      <span className="flex gap-2">
      <button
        type="button"
        aria-label="縮小"
        onClick={() => setRange(zoomRange(range, 2, now, maxMs))}
        className="min-h-10 rounded border border-gray-300 px-3 py-2 hover:bg-gray-100 sm:min-h-0 sm:px-2 sm:py-1"
      >
        －
      </button>
      <button
        type="button"
        aria-label="拡大"
        onClick={() => setRange(zoomRange(range, 0.5, now, maxMs))}
        className="min-h-10 rounded border border-gray-300 px-3 py-2 hover:bg-gray-100 sm:min-h-0 sm:px-2 sm:py-1"
      >
        ＋
      </button>
      </span>

      <span className="inline-block">
      <select
        aria-label="表示期間"
        value={presetKeyOf(range) ?? "custom"}
        onChange={(event) => {
          const preset = PRESETS.find((p) => p.key === e.target.value);
          if (preset) setRange({ mode: "relative", durationMs: preset.durationMs });
        }}
        className="rounded border border-gray-300 px-2 py-1"
      >
        {PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        {presetKeyOf(range) === null && <option value="custom">{describeRange(range)}</option>}
      </select>
      </span>

      <span className="text-xs text-gray-500" data-testid="time-range-label">
        {range.mode === "relative" ? "自動で更新" : "固定"}：{describeRange(range)}
      </span>

      <details className="text-xs">
        <summary className="cursor-pointer text-gray-600">期間を指定</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            開始
            <input
              type="datetime-local"
              aria-label="開始"
              value={customFrom || toLocalInput(bounds.from)}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="rounded border border-gray-300 px-1 py-0.5"
            />
          </label>
          <label className="flex items-center gap-1">
            終了
            <input
              type="datetime-local"
              aria-label="終了"
              value={customTo || toLocalInput(bounds.to)}
              onChange={(event) => setCustomTo(event.target.value)}
              className="rounded border border-gray-300 px-1 py-0.5"
            />
          </label>
          <button
            type="button"
            onClick={applyCustom}
            className="rounded bg-gray-800 px-2 py-1 text-white hover:bg-gray-700"
          >
            適用
          </button>
          {error && <span className="text-red-600">{error}</span>}
        </div>
      </details>
    </div>
  );
}
