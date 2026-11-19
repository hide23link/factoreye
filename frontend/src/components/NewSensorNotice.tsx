/**
 * 新しいセンサーが届いたときに、画面の上に出す通知カード。
 * この端末がまだ見ていないセンサー（lib/new-sensors.ts）がセンサー一覧に現れたら出す。複数同時なら 1 枚にまとめる。
 * - 「ダッシュボードに追加」: 開いているダッシュボードに、センサーごとにセンサーグラフを 1 枚足す。
 *   開いているものが無ければ、新しいダッシュボードを作ってそこへ足し、開く。
 * - 「あとで」: カードを閉じる。閉じた分も「見た」ことになり、もう通知しない。
 * 初回（この端末に記録が無いとき）は、いま在るセンサーをすべて「見た」ことにして、何も出さない。
 *
 * 【誰が使うか】App.tsx の MainShell が、上の帯の下に 1 つ差し込む。引数（props）はない。
 * 【取得】センサー一覧は useSensors（5 秒ごとの取り直しで検知）。ミニグラフは直近 5 時間の値（30 秒ごと）。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useSensorReadings, useSensors } from "../hooks/queries";
import { addWidget, createDashboard, fetchDashboard, fetchDashboards } from "../lib/api";
import { nextDashboardName } from "../lib/dashboard-name";
import { describeActionError } from "../lib/errors";
import { bottomRow, findFreeSpot } from "../lib/grid-placement";
import { addSeen, findNewSensorIds, readSeenSensorIds, writeSeenSensorIds } from "../lib/new-sensors";
import { widgetKind } from "../lib/widget-catalog";
import { useUiStore } from "../store/useUiStore";
import type { Sensor } from "../types";
import { Sparkline } from "./editor/Sparkline";

/** カードに並べるセンサーの最大数（残りは「ほか N 件」） */
const MAX_ROWS = 4;
/** ミニグラフが見る期間（時間）と、取る点の上限 */
const MINI_HOURS = 5;
const MINI_LIMIT = 120;

/** 1 センサーの行（名前と、直近 5 時間のミニグラフ）。値が 2 点そろうまでは「データを待っています」 */
function NewSensorRow({ sensor }: { sensor: Sensor }) {
  const { data } = useSensorReadings(sensor.id, MINI_HOURS, MINI_LIMIT, 30000);
  // 取得は新しい順。グラフは古い順に描く
  const values = [...(data?.readings ?? [])].reverse().map((r) => r.value);
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-0 truncate font-bold">{sensor.name}</span>
      <span className="flex shrink-0 items-center gap-2 text-xs" style={{ color: "var(--fe-mut)" }}>
        直近 {MINI_HOURS} 時間
        {values.length >= 2 ? <Sparkline values={values} width={120} height={28} /> : <span>データを待っています</span>}
      </span>
    </li>
  );
}

export function NewSensorNotice() {
  const { data: sensors } = useSensors();
  const queryClient = useQueryClient();
  const selectedDashboardId = useUiStore((s) => s.selectedDashboardId);
  const selectDashboard = useUiStore((s) => s.selectDashboard);

  // この端末が見たセンサー ID（null = 初回）。画面の描き直しでは読み直さないよう、ref に持つ
  const seenRef = useRef<Set<string> | null | undefined>(undefined);
  if (seenRef.current === undefined) seenRef.current = readSeenSensorIds();
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  // 一覧が取れるたびに、見ていないセンサーを通知待ちへ足す。初回は、全部を見たことにして記録するだけ
  useEffect(() => {
    if (!sensors) return;
    if (seenRef.current === null) {
      seenRef.current = addSeen(null, sensors.map((s) => s.id));
      writeSeenSensorIds(seenRef.current);
      return;
    }
    const fresh = findNewSensorIds(sensors.map((s) => s.id), seenRef.current ?? null, pendingIds);
    if (fresh.length > 0) setPendingIds((ids) => [...ids, ...fresh]);
  }, [sensors, pendingIds]);

  /** 通知を閉じ、いま出している分を「見た」ことにして記録する */
  const markShownAsSeen = (ids: string[]) => {
    seenRef.current = addSeen(seenRef.current ?? null, ids);
    writeSeenSensorIds(seenRef.current);
    setPendingIds((current) => current.filter((id) => !ids.includes(id)));
  };

  const shown = (sensors ?? []).filter((s) => pendingIds.includes(s.id));
  const shownIds = shown.map((s) => s.id);

  // 開いているダッシュボードに、センサーごとのグラフを足す。無ければ新しく作る
  const addMutation = useMutation({
    mutationFn: async () => {
      const kind = widgetKind("SensorGraph");
      if (!kind) throw new Error("グラフの種類が見つかりません");
      let dashboardId = selectedDashboardId;
      let widgets = dashboardId ? (await fetchDashboard(dashboardId)).widgets : [];
      if (dashboardId === null) {
        const names = (await fetchDashboards()).map((d) => d.name);
        dashboardId = (await createDashboard({ name: nextDashboardName(names) })).id;
      }
      for (const id of shownIds) {
        const spot = findFreeSpot(widgets, kind.width, kind.height, 1, bottomRow(widgets));
        const widget = await addWidget(dashboardId, {
          type: "SensorGraph",
          sensorId: id,
          gridColumn: spot.column,
          gridRow: spot.row,
          gridWidth: spot.width,
          gridHeight: spot.height,
          config: kind.defaultConfig,
        });
        widgets = [...widgets, widget];
      }
      return dashboardId;
    },
    onSuccess: (dashboardId) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
      markShownAsSeen(shownIds);
      selectDashboard(dashboardId);
    },
  });

  if (shown.length === 0) return null;

  const heading =
    shown.length === 1
      ? `新しい機器『${shown[0].name}』から最初のデータが届きました`
      : `新しい機器 ${shown.length} 台から最初のデータが届きました`;

  return (
    <section
      role="status"
      aria-label="新しいセンサーの通知"
      className="mx-3 mt-3 rounded-md border px-3 py-2.5 sm:mx-4"
      style={{ background: "var(--fe-panel)", borderColor: "var(--fe-line)", color: "var(--fe-ink)" }}
    >
      <p className="text-sm font-bold">{heading}</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {shown.slice(0, MAX_ROWS).map((sensor) => (
          <NewSensorRow key={sensor.id} sensor={sensor} />
        ))}
      </ul>
      {shown.length > MAX_ROWS && (
        <p className="mt-1 text-xs" style={{ color: "var(--fe-mut)" }}>
          ほか {shown.length - MAX_ROWS} 件
        </p>
      )}
      {addMutation.isError && (
        <p role="alert" className="mt-2 text-sm" style={{ color: "var(--fe-red)" }}>
          {describeActionError(addMutation.error, "ダッシュボードへの追加")}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={addMutation.isPending}
          onClick={() => addMutation.mutate()}
          aria-label="ダッシュボードに追加"
          className="min-h-9 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          ダッシュボードに追加
        </button>
        <button
          type="button"
          disabled={addMutation.isPending}
          onClick={() => markShownAsSeen(shownIds)}
          aria-label="あとで"
          className="min-h-9 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
        >
          あとで
        </button>
      </div>
    </section>
  );
}
