/**
 * 画面表示モード（キオスク）の操作バー。画面の上に重ねて出し、数秒操作がなければ自動で隠れる。
 * 終える・表示期間・前後のダッシュボード・自動切替（間隔と対象）を操作できる。並びと大きさは、通常の画面と同じ（変えない）。
 *
 * 【誰が使うか】DashboardView が、画面表示モード中に出す。
 * 【引数（props）】dashboardId = 今表示中のダッシュボード、onExit = モードを終える、onInteract = 操作があった合図（隠れるまでの時間を延ばす）。
 */
import { useDashboards } from "../hooks/queries";
import { maxRangeForBuild, PRESETS } from "../lib/timeRange";
import { KIOSK_CYCLES, useKioskStore } from "../store/useKioskStore";
import { useTimeRangeStore } from "../store/useTimeRangeStore";
import { useUiStore } from "../store/useUiStore";

const buttonClass = "min-h-10 rounded border border-white/40 px-3 py-1.5 text-sm hover:bg-white/20";

export function KioskBar({ dashboardId, onExit, onInteract }: { dashboardId: string; onExit: () => void; onInteract: () => void }) {
  const { cycleSeconds, cycleExcluded, update } = useKioskStore();
  const range = useTimeRangeStore((s) => s.range);
  const setRange = useTimeRangeStore((s) => s.setRange);
  const switchDashboard = useUiStore((s) => s.switchDashboard);
  const { data: dashboards } = useDashboards();

  const presets = PRESETS.filter((p) => p.durationMs <= maxRangeForBuild());
  const presetKey = range.mode === "relative" ? (presets.find((p) => p.durationMs === range.durationMs)?.key ?? "") : "";

  const list = dashboards ?? [];
  const index = list.findIndex((d) => d.id === dashboardId);
  const move = (step: 1 | -1) => {
    if (list.length < 2) return;
    switchDashboard(list[(Math.max(index, 0) + step + list.length) % list.length].id);
  };
  const toggleTarget = (id: string) =>
    update({ cycleExcluded: cycleExcluded.includes(id) ? cycleExcluded.filter((x) => x !== id) : [...cycleExcluded, id] });

  return (
    <div
      role="toolbar"
      aria-label="画面表示の操作"
      // どの操作でも、隠れるまでの時間を延ばす
      onPointerDown={onInteract}
      onChange={onInteract}
      className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center gap-2 bg-gray-900/95 p-2 text-sm text-white shadow-lg"
    >
      <button type="button" aria-label="画面表示を終える" onClick={onExit} className="min-h-10 rounded bg-white px-3 py-1.5 text-sm font-semibold text-gray-900">
        ✕ 終える
      </button>
      {index >= 0 && <span className="max-w-[40vw] truncate font-semibold">{list[index].name}</span>}

      <select
        aria-label="表示期間"
        value={presetKey}
        onChange={(e) => {
          const preset = presets.find((p) => p.key === e.target.value);
          if (preset) setRange({ mode: "relative", durationMs: preset.durationMs });
        }}
        className="min-h-10 rounded border border-white/40 bg-gray-800 px-2 text-sm"
      >
        {presetKey === "" && <option value="">期間（固定）</option>}
        {presets.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>

      {list.length > 1 && (
        <>
          <button type="button" aria-label="前のダッシュボード" onClick={() => move(-1)} className={buttonClass}>
            ‹ 前
          </button>
          <button type="button" aria-label="次のダッシュボード" onClick={() => move(1)} className={buttonClass}>
            次 ›
          </button>
          <select
            aria-label="自動切替の間隔"
            value={cycleSeconds}
            onChange={(e) => update({ cycleSeconds: Number(e.target.value) })}
            className="min-h-10 rounded border border-white/40 bg-gray-800 px-2 text-sm"
          >
            {KIOSK_CYCLES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.value === 0 ? c.label : `自動切替 ${c.label}`}
              </option>
            ))}
          </select>
          {cycleSeconds > 0 && (
            <details className="relative">
              <summary className="flex min-h-10 cursor-pointer items-center rounded border border-white/40 px-3 text-sm">切替の対象</summary>
              <div className="absolute left-0 top-full z-10 mt-1 max-h-64 min-w-48 overflow-auto rounded border border-white/30 bg-gray-800 p-2">
                {list.map((d) => (
                  <label key={d.id} className="flex min-h-9 items-center gap-2 whitespace-nowrap">
                    <input type="checkbox" checked={!cycleExcluded.includes(d.id)} onChange={() => toggleTarget(d.id)} />
                    {d.name}
                  </label>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
