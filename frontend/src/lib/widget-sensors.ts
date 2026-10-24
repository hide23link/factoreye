/**
 * センサーをウィジェットに割り当てたときの、ウィジェットの変更内容を決める。
 * ドラッグ＆ドロップ、「＋」ボタン、設定パネルの「センサーを追加」（SensorPicker）が同じ規則を使う。
 *
 * - グラフ: 追加（すでにあれば何もしない）。「入れ替え」を選んだときは、そのセンサーだけにする
 * - 数値・稼働ステータス・生産管理: センサーを入れ替える
 * - アラーム一覧: センサーを持たないので、割り当てできない
 * 生産管理に生産数らしくないセンサーを入れたときは、設定はするが、注意を返す（種類は名前からの推測のため）。
 *
 * 【誰が使うか】useWidgetActions。
 */
import type { Sensor, Widget, WidgetConfig } from "../types";
import { graphSensorIds, graphSensorPatch } from "./graph-config";
import { guessSensorKind } from "./sensor-kind";

export type AssignMode = "add" | "replace";

export type Assignment =
  | { ok: true; sensorId: string | null; config: WidgetConfig; message: string }
  | { ok: false; message: string };

export function assignSensor(widget: Widget, sensor: Sensor, mode: AssignMode): Assignment {
  switch (widget.type) {
    case "SensorGraph":
    case "MultiSensorComparison": {
      const ids = graphSensorIds(widget);
      if (mode === "add" && ids.includes(sensor.id)) {
        return { ok: false, message: `「${sensor.name}」はすでにこのグラフにあります` };
      }
      const next = mode === "add" ? [...ids, sensor.id] : [sensor.id];
      // 追加は既存の線の色を保つ。入れ替えは新しい 1 本だけ
      const keep = mode === "add" ? ids.map((_, i) => i) : [];
      const patch = graphSensorPatch(widget, next, keep);
      const message =
        mode === "add" ? `「${sensor.name}」をグラフに追加しました` : `グラフを「${sensor.name}」に入れ替えました`;
      return { ok: true, ...patch, message };
    }
    case "StatValue":
      return { ok: true, sensorId: sensor.id, config: widget.config, message: `数値を「${sensor.name}」に切り替えました` };
    case "ProductionStatus":
      return { ok: true, sensorId: sensor.id, config: widget.config, message: `稼働ステータスを「${sensor.name}」に切り替えました` };
    case "ProductionPlan": {
      const suited = guessSensorKind(sensor) === "count";
      return {
        ok: true,
        sensorId: sensor.id,
        config: widget.config,
        message: suited
          ? `生産管理を「${sensor.name}」に切り替えました`
          : `生産管理を「${sensor.name}」に切り替えました（生産数のセンサーではなさそうです。確認してください）`,
      };
    }
    default:
      return { ok: false, message: "このウィジェットにはセンサーを設定できません" };
  }
}

/** このウィジェットにセンサーを割り当てられるか（ドラッグ中の見た目の判定に使う） */
export function acceptsSensor(widget: Pick<Widget, "type">): boolean {
  return widget.type !== "AlarmAlert";
}
