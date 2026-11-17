/**
 * 配置図のウィジェット。管制塔のレーダー画面のように、部屋の枠の上に機器の札を置いて、全部の状態を 1 枚で見る。
 *
 * 札: 機器（機器に属さないセンサーは 1 つ）ごとの小さな四角（状態の色）と、名前・値の札。
 * 状態の決め方・値の並べ方は全体監視と同じ（lib/overview.ts）。
 * 「配置を編集」を押すと、部屋の枠と札を、ドラッグ（矢印キーでも）で動かせる。部屋は右下の角で大きさを変える。
 * 札は、矢印キーで動かし、Delete で外せる（外した札は「まだ置いていない機器」に戻る）。
 * 「保存」でウィジェットの設定（floorRooms・floorPlacements）に書く。サーバー側は、設定の自由な JSON なので変更不要。
 * ダッシュボードの編集モードとは別の操作（編集モードでは、ウィジェットの中の操作を止めるため）。
 *
 * 【誰が使うか】WidgetCard.tsx（種類が "FloorPlan"）と、全体監視の画面（OverviewPage.tsx）。
 * 【引数（props）】widget = このウィジェット（部屋・札の位置は widget.config）。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { useAlarms, useLatestReadings, useSensors } from "../../hooks/queries";
import { useNow } from "../../hooks/useNow";
import { updateWidget } from "../../lib/api";
import { describeActionError } from "../../lib/errors";
import { clampPoint, moveRoom, newRoom, readFloorPlan, resizeRoom, unplacedKeys } from "../../lib/floor-plan";
import { buildStrips, formatAge, type Strip, type StripState } from "../../lib/overview";
import type { FloorPlacements, FloorRoom, Widget } from "../../types";
import { ErrorNotice } from "../ErrorNotice";

const STATE_COLOR: Record<StripState, string> = {
  critical: "var(--fe-red)",
  warning: "var(--fe-amb)",
  normal: "var(--fe-ink)",
  never: "var(--fe-mut)",
};

// 矢印キーで動かす幅（割合）
const KEY_STEP = 1;

/** いま動かしているもの（部屋の移動・部屋の大きさ・札の移動）と、つかんだ位置 */
type Drag =
  | { kind: "room"; id: string; lastX: number; lastY: number }
  | { kind: "resize"; id: string; lastX: number; lastY: number }
  | { kind: "strip"; key: string; offsetX: number; offsetY: number };

/** 札の 1 行目に出す値（先頭の 2 つ。例: 「22.4℃ 49%」） */
function shortValues(strip: Strip): string {
  return strip.sensors
    .slice(0, 2)
    .map((item) => (item.latest ? `${Math.abs(item.latest.value) >= 100 ? Math.round(item.latest.value) : Number(item.latest.value.toFixed(1))}${item.sensor.unit}` : "---"))
    .join(" ");
}

export function FloorPlanWidget({ widget }: { widget: Widget }) {
  const sensors = useSensors();
  const latest = useLatestReadings();
  const active = useAlarms("active", 200);
  const acknowledged = useAlarms("acknowledged", 200);
  const now = useNow(10_000);
  const queryClient = useQueryClient();
  const planRef = useRef<HTMLDivElement>(null);

  const saved = readFloorPlan(widget.config);
  // 編集中の下書き。null は、編集していないとき（保存してある内容を出す）
  const [draft, setDraft] = useState<{ rooms: FloorRoom[]; placements: FloorPlacements } | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const editing = draft !== null;

  const save = useMutation({
    mutationFn: (plan: { rooms: FloorRoom[]; placements: FloorPlacements }) =>
      updateWidget(widget.id, { config: { ...widget.config, floorRooms: plan.rooms, floorPlacements: plan.placements } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", widget.dashboardId] });
      void queryClient.invalidateQueries({ queryKey: ["floor-plan-widgets"] });
      setDraft(null);
      setSelectedRoom(null);
    },
  });

  if (!sensors.data && sensors.isError) return <ErrorNotice message="機器の様子を取得できませんでした。" onRetry={() => void sensors.refetch()} />;
  if (!sensors.data || !latest.data) return <p className="text-sm text-gray-500">読み込み中...</p>;

  const unresolved = [...(active.data?.alarms ?? []), ...(acknowledged.data?.alarms ?? [])];
  const strips = buildStrips(sensors.data, latest.data.readings, unresolved, now);
  const stripByKey = new Map(strips.map((strip) => [strip.key, strip]));
  const plan = draft ?? saved;
  const unplaced = unplacedKeys(strips.map((s) => s.key), plan.placements);

  const update = (next: { rooms: FloorRoom[]; placements: FloorPlacements }) => setDraft(next);

  /** ポインタの位置（画面の座標）を、配置図の割合（0〜100）にする */
  const toPercent = (event: PointerEvent): { x: number; y: number } | null => {
    const box = planRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    return { x: ((event.clientX - box.left) / box.width) * 100, y: ((event.clientY - box.top) / box.height) * 100 };
  };

  const startDrag = (event: PointerEvent, next: Drag) => {
    if (!editing) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(next);
  };

  const onMove = (event: PointerEvent) => {
    if (!drag || !draft) return;
    const point = toPercent(event);
    if (!point) return;
    if (drag.kind === "strip") {
      update({ ...draft, placements: { ...draft.placements, [drag.key]: clampPoint(point.x - drag.offsetX, point.y - drag.offsetY) } });
      return;
    }
    const dx = point.x - drag.lastX;
    const dy = point.y - drag.lastY;
    setDrag({ ...drag, lastX: point.x, lastY: point.y });
    update({
      ...draft,
      rooms: draft.rooms.map((room) => (room.id !== drag.id ? room : drag.kind === "room" ? moveRoom(room, dx, dy) : resizeRoom(room, dx, dy))),
    });
  };

  const onKey = (event: KeyboardEvent, key: string) => {
    if (!draft) return;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] };
    const move = delta[event.key];
    const current = draft.placements[key];
    if (!current) return;
    // Delete で札を外す（「まだ置いていない機器」に戻る）
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      update({ ...draft, placements: Object.fromEntries(Object.entries(draft.placements).filter(([k]) => k !== key)) });
      return;
    }
    if (!move) return;
    event.preventDefault();
    update({ ...draft, placements: { ...draft.placements, [key]: clampPoint(current.x + move[0], current.y + move[1]) } });
  };

  const place = (key: string) => {
    if (!draft) return;
    update({ ...draft, placements: { ...draft.placements, [key]: clampPoint(40, 40) } });
  };

  const selected = draft?.rooms.find((room) => room.id === selectedRoom) ?? null;

  return (
    <div className="flex h-full min-h-[260px] flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {!editing ? (
          <button type="button" onClick={() => setDraft({ rooms: saved.rooms, placements: saved.placements })} className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-100">
            配置を編集
          </button>
        ) : (
          <>
            <button type="button" onClick={() => { const room = newRoom(plan.rooms); update({ ...plan, rooms: [...plan.rooms, room] }); setSelectedRoom(room.id); }} className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-100">
              部屋を追加
            </button>
            {selected && (
              <>
                <label className="flex items-center gap-1">
                  <span className="text-gray-500">部屋の名前</span>
                  <input
                    aria-label="部屋の名前"
                    value={selected.name}
                    onChange={(event) => update({ ...plan, rooms: plan.rooms.map((room) => (room.id === selected.id ? { ...room, name: event.target.value } : room)) })}
                    className="w-28 rounded border border-gray-300 px-1.5 py-0.5"
                  />
                </label>
                <button type="button" onClick={() => { update({ ...plan, rooms: plan.rooms.filter((room) => room.id !== selected.id) }); setSelectedRoom(null); }} className="rounded border border-red-300 px-2 py-1 text-red-600 hover:bg-red-50">
                  この部屋を消す
                </button>
              </>
            )}
            <span className="flex-1" />
            <button type="button" onClick={() => void save.mutateAsync(plan).catch(() => {})} disabled={save.isPending} className="rounded px-2.5 py-1 font-bold disabled:opacity-50" style={{ background: "var(--fe-cy)", color: "var(--fe-panel)" }}>
              保存
            </button>
            <button type="button" onClick={() => { setDraft(null); setSelectedRoom(null); }} className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-100">
              取り消す
            </button>
          </>
        )}
        {save.isError && <span role="alert" className="text-red-600">{describeActionError(save.error, "配置の保存")}</span>}
        {!editing && plan.rooms.length === 0 && Object.keys(plan.placements).length === 0 && <span className="text-gray-500">「配置を編集」で、部屋と機器の札を置けます</span>}
      </div>

      <div
        ref={planRef}
        className="relative min-h-[220px] flex-1 overflow-hidden rounded-sm border"
        style={{
          borderColor: "var(--fe-line)",
          backgroundColor: "var(--fe-bg)",
          backgroundImage: "linear-gradient(var(--fe-grid-time) 1px, transparent 1px), linear-gradient(90deg, var(--fe-grid-time) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          touchAction: editing ? "none" : "auto",
        }}
        onPointerMove={onMove}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        onPointerDown={() => setSelectedRoom(null)}
        role="group"
        aria-label="配置図"
      >
        {plan.rooms.map((room) => (
          <div
            key={room.id}
            className="absolute box-border border px-1.5 py-1 text-[11px]"
            style={{
              left: `${room.x}%`,
              top: `${room.y}%`,
              width: `${room.w}%`,
              height: `${room.h}%`,
              borderColor: room.id === selectedRoom ? "var(--fe-cy)" : "var(--fe-line)",
              color: "var(--fe-mut)",
              cursor: editing ? "move" : "default",
            }}
            onPointerDown={(event) => {
              setSelectedRoom(room.id);
              const point = toPercent(event);
              if (point) startDrag(event, { kind: "room", id: room.id, lastX: point.x, lastY: point.y });
            }}
          >
            {room.name}
            {editing && (
              <span
                role="presentation"
                className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
                style={{ background: "var(--fe-cy)" }}
                onPointerDown={(event) => {
                  const point = toPercent(event);
                  if (point) startDrag(event, { kind: "resize", id: room.id, lastX: point.x, lastY: point.y });
                }}
              />
            )}
          </div>
        ))}

        {Object.entries(plan.placements).map(([key, point]) => {
          const strip = stripByKey.get(key);
          if (!strip) return null;
          const color = STATE_COLOR[strip.state];
          const emphasis = strip.state === "critical" || strip.state === "warning";
          const stale = strip.lastTime !== null && now - strip.lastTime > 15 * 60_000;
          return (
            <button
              key={key}
              type="button"
              disabled={!editing}
              aria-label={`${strip.title} ${strip.reason ?? shortValues(strip)}${editing ? "（ドラッグか矢印キーで動かす、Delete で外す）" : ""}`}
              className="absolute flex items-start gap-1 text-left disabled:cursor-default"
              style={{ left: `${point.x}%`, top: `${point.y}%`, cursor: editing ? "grab" : "default" }}
              onPointerDown={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const at = toPercent(event);
                // つかんだ位置と札の左上のずれ（割合）を覚え、つかんだ所がずれないように動かす
                const origin = planRef.current?.getBoundingClientRect();
                if (at && origin) startDrag(event, { kind: "strip", key, offsetX: at.x - ((box.left - origin.left) / origin.width) * 100, offsetY: at.y - ((box.top - origin.top) / origin.height) * 100 });
              }}
              onKeyDown={(event) => onKey(event, key)}
            >
              <span className="mt-0.5 h-2.5 w-2.5 shrink-0 border-2" style={{ borderColor: color, background: strip.state === "critical" ? color : "transparent", borderStyle: stale || strip.state === "never" ? "dashed" : "solid" }} aria-hidden="true" />
              <span
                className="whitespace-nowrap border px-1 font-num text-[11px] leading-tight"
                style={{ color: emphasis ? color : "var(--fe-ink)", borderColor: strip.state === "critical" ? color : "transparent", background: strip.state === "critical" ? "var(--fe-red-bg)" : "color-mix(in srgb, var(--fe-panel) 85%, transparent)" }}
              >
                <b>{strip.title}</b>
                <br />
                {strip.reason ?? shortValues(strip)}
                {strip.lastTime !== null && !emphasis ? <span style={{ color: "var(--fe-mut)" }}> {formatAge(now - strip.lastTime)}</span> : null}
              </span>
            </button>
          );
        })}
        <p className="pointer-events-none absolute bottom-1 right-2 text-right font-num text-[10px] leading-tight" style={{ color: "var(--fe-mut)" }}>
          □ 正常&emsp;■ 警報&emsp;◇ 注意&emsp;点線の枠 = 受信が止まっている
        </p>
      </div>

      {editing && unplaced.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-gray-500">まだ置いていない機器（押すと置く）</span>
          {unplaced.map((key) => (
            <button key={key} type="button" onClick={() => place(key)} className="rounded border border-gray-300 px-1.5 py-0.5 font-num hover:bg-gray-100">
              + {stripByKey.get(key)?.title ?? key}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
