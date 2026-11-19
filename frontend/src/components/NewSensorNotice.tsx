/**
 * 新しいセンサーが届いたときに、画面の上に出す通知カード。
 * この端末がまだ見ていないセンサー（lib/new-sensors.ts）がセンサー一覧に現れたら出す。複数同時なら 1 枚にまとめる。
 * - 「ダッシュボードに追加」: 開いているダッシュボードに、センサーごとにセンサーグラフを 1 枚足す。
 *   開いているものが無ければ、新しいダッシュボードを作ってそこへ足し、開く。
 * - 「あとで」: カードを閉じる。閉じた分も「見た」ことになり、もう通知しない。
 * 初回（この端末に記録が無いとき）は、いま在るセンサーをすべて「見た」ことにして、何も出さない。
 * 記録は利用者（ワークスペース）ごと。管理者の代理閲覧中と、画面表示モード（キオスク）では、出さない。
 * 一度に出す・追加するのは最大 8 件まで（残りは編集画面のセンサー棚から追加できる旨を案内し、「見た」にする）。
 * 追加が途中で失敗したら、足せた分は「見た」にし、作ったダッシュボードは覚えておく。再試行では残りだけを足す。
 *
 * 【誰が使うか】App.tsx の MainShell が、上の帯の下に 1 つ差し込む。引数（props）はない。
 * 【取得】センサー一覧は useSensors（5 秒ごとの取り直しで検知）。ミニグラフは直近 5 時間の値（30 秒ごと）。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { useSensorReadings, useSensors } from "../hooks/queries";
import { addWidget, createDashboard, fetchDashboard, fetchDashboards } from "../lib/api";
import { nextDashboardName } from "../lib/dashboard-name";
import { describeActionError } from "../lib/errors";
import { bottomRow, findFreeSpot } from "../lib/grid-placement";
import { MAX_NOTICE_SENSORS, addSeen, findNewSensorIds, readSeenSensorIds, splitForAdd, writeSeenSensorIds } from "../lib/new-sensors";
import { widgetKind } from "../lib/widget-catalog";
import { useAuthStore } from "../store/useAuthStore";
import { useUiStore } from "../store/useUiStore";
import type { Sensor } from "../types";
import { Sparkline } from "./editor/Sparkline";

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
  const kiosk = useUiStore((s) => s.kiosk);
  const impersonating = useAuthStore((s) => s.impersonation !== null);
  const scope = useAuthStore((s) => s.me?.workspaceId) ?? "local";

  // この端末が見たセンサー ID（null = 初回）。利用者が替わったら読み直す。描き直しでは読み直さない
  const seenRef = useRef<{ scope: string; ids: Set<string> | null } | null>(null);
  if (seenRef.current === null || seenRef.current.scope !== scope) {
    seenRef.current = { scope, ids: readSeenSensorIds(scope) };
  }
  const [pending, setPending] = useState<{ scope: string; ids: string[] }>({ scope, ids: [] });
  const pendingIds = useMemo(() => (pending.scope === scope ? pending.ids : []), [pending, scope]);
  // 追加の途中で作ったダッシュボード（再試行で、もう 1 つ作らないため）
  const createdDashboardRef = useRef<string | null>(null);

  // 一覧が取れるたびに、見ていないセンサーを通知待ちへ足す。初回は、全部を見たことにして記録するだけ。代理閲覧中は何もしない
  useEffect(() => {
    if (!sensors || impersonating) return;
    const seen = seenRef.current;
    if (!seen) return;
    if (seen.ids === null) {
      seen.ids = addSeen(null, sensors.map((s) => s.id));
      writeSeenSensorIds(scope, seen.ids);
      return;
    }
    const fresh = findNewSensorIds(sensors.map((s) => s.id), seen.ids, pendingIds);
    if (fresh.length > 0) setPending({ scope, ids: [...pendingIds, ...fresh] });
  }, [sensors, pendingIds, scope, impersonating]);

  /** ids を「見た」ことにして記録し、通知待ちから外す */
  const markSeen = (ids: string[]) => {
    const seen = seenRef.current;
    if (!seen) return;
    seen.ids = addSeen(seen.ids, ids);
    writeSeenSensorIds(scope, seen.ids);
    setPending((current) => ({ scope, ids: (current.scope === scope ? current.ids : []).filter((id) => !ids.includes(id)) }));
  };

  const shown = impersonating ? [] : (sensors ?? []).filter((s) => pendingIds.includes(s.id));
  const { head: addIds, rest: restIds } = splitForAdd(
    shown.map((s) => s.id),
    MAX_NOTICE_SENSORS,
  );
  const rows = shown.slice(0, MAX_NOTICE_SENSORS);

  // 開いているダッシュボードに、センサーごとのグラフを足す。無ければ新しく作る。
  // 引数 = 今回足すセンサーと、案内だけして「見た」にする残り。足せたものから順に「見た」にする
  const addMutation = useMutation({
    mutationFn: async ({ ids }: { ids: string[]; rest: string[] }) => {
      const kind = widgetKind("SensorGraph");
      if (!kind) throw new Error("グラフの種類が見つかりません");
      let dashboardId = createdDashboardRef.current ?? selectedDashboardId;
      if (dashboardId === null) {
        const names = (await fetchDashboards()).map((d) => d.name);
        dashboardId = (await createDashboard({ name: nextDashboardName(names) })).id;
        createdDashboardRef.current = dashboardId;
      }
      let widgets = (await fetchDashboard(dashboardId)).widgets;
      for (const id of ids) {
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
        markSeen([id]);
      }
      return dashboardId;
    },
    onSuccess: (dashboardId, { rest }) => {
      createdDashboardRef.current = null;
      markSeen(rest);
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
      selectDashboard(dashboardId);
    },
    onError: () => {
      // 途中まで足せていれば、その分の表示を取り直す
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  // 1 つだけのときは、値が届いているかで見出しを変える（ミニグラフの取得と同じ問い合わせ）
  const { data: firstReadings } = useSensorReadings(rows.length === 1 ? rows[0].id : null, MINI_HOURS, MINI_LIMIT, 30000);

  if (shown.length === 0 || kiosk) return null;

  const hasData = (firstReadings?.readings.length ?? 0) > 0;
  const heading =
    shown.length === 1
      ? hasData
        ? `新しい機器『${shown[0].name}』から最初のデータが届きました`
        : `新しいセンサー『${shown[0].name}』が追加されました。データを待っています`
      : `新しいセンサーが ${shown.length} 件見つかりました`;

  return (
    <section
      role="status"
      aria-label="新しいセンサーの通知"
      className="mx-3 mt-3 rounded-md border px-3 py-2.5 sm:mx-4"
      style={{ background: "var(--fe-panel)", borderColor: "var(--fe-line)", color: "var(--fe-ink)" }}
    >
      <p className="text-sm font-bold">{heading}</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {rows.map((sensor) => (
          <NewSensorRow key={sensor.id} sensor={sensor} />
        ))}
      </ul>
      {restIds.length > 0 && (
        <p className="mt-1 text-xs" style={{ color: "var(--fe-mut)" }}>
          ほか {restIds.length} 件は、編集画面のセンサー棚から追加できます
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
          onClick={() => {
            if (!addMutation.isPending) addMutation.mutate({ ids: addIds, rest: restIds });
          }}
          aria-label="ダッシュボードに追加"
          className="min-h-9 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          ダッシュボードに追加
        </button>
        <button
          type="button"
          disabled={addMutation.isPending}
          onClick={() => markSeen(shown.map((s) => s.id))}
          aria-label="あとで"
          className="min-h-9 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
        >
          あとで
        </button>
      </div>
    </section>
  );
}
