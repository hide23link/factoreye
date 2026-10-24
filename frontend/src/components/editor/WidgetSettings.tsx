/**
 * 選んだウィジェットの設定（右の設定パネルの中身）。
 * 種類ごとの項目を出し、変更はすぐ画面に反映して保存する（保存ボタンは無い）。
 *
 * 【誰が使うか】SettingsPanel。
 * 【引数（props）】widget = 選んだウィジェット、dashboard = 属するダッシュボード（保存の操作に使う）。
 */
import { useState } from "react";

import { useMovableWindow } from "../../hooks/useMovableWindow";
import { useWidgetActions } from "../../hooks/useWidgetActions";
import {
  MAX_LINE_WIDTH,
  REFRESH_SECONDS_OPTIONS,
  graphColor,
  graphDataOptions,
  graphSensorIds,
  graphSensorPatch,
  defaultLineShape,
  graphStyle,
  nextGraphColor,
  thresholdMode,
  type Aggregation,
  type AxisMode,
  type LegendPosition,
  type LineShape,
  type StackMode,
  type ThresholdMode,
} from "../../lib/graph-config";
import {
  planPerWorkHour,
  scheduleFromConfig,
  totalWorkMinutes,
} from "../../lib/production-plan";
import { useEditorStore } from "../../store/useEditorStore";
import { widgetLabel } from "../../lib/widget-catalog";
import type { DashboardDetail, Sensor, Widget, WidgetConfig } from "../../types";
import { NumberField, Section, Segmented, Toggle } from "./controls";
import { SensorField } from "./SensorField";
import { WidgetIcon } from "./WidgetIcon";

type Actions = ReturnType<typeof useWidgetActions>;

interface SectionProps {
  widget: Widget;
  actions: Actions;
}

/** 設定の一部だけを変える（最新の設定に重ねて保存する。undefined の項目は未指定に戻す） */
const changeConfig = (actions: Actions, widget: Widget, change: Partial<WidgetConfig>) => actions.patchConfig(widget, change);

export function WidgetSettings({ widget, dashboard }: { widget: Widget; dashboard: DashboardDetail }) {
  const actions = useWidgetActions(dashboard);
  const { handleProps, resetButton } = useMovableWindow("panel", "設定パネル");

  return (
    <>
      <div
        {...handleProps}
        className="flex cursor-grab touch-none select-none items-center gap-2.5 border-b border-gray-200 px-3.5 py-3 active:cursor-grabbing"
      >
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-50 text-blue-600">
          <WidgetIcon type={widget.type} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold" title="変更はすぐ画面に反映されます">
            {widgetLabel(widget.type)}の設定
          </h3>
                  </div>
        {resetButton}
        <button
          type="button"
          aria-label="設定パネルを閉じる"
          onClick={() => useEditorStore.getState().setPanelOpen(false)}
          className="h-6 w-6 shrink-0 rounded text-gray-500 hover:bg-gray-100"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-col overflow-auto px-3.5 pb-3.5">
        <TypeSettings widget={widget} actions={actions} />
        <Section title="操作">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void actions.duplicate(widget)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              複製
            </button>
            <button
              type="button"
              onClick={() => void actions.remove(widget)}
              className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
            >
              このウィジェットを削除
            </button>
          </div>
        </Section>
      </div>
    </>
  );
}

function TypeSettings({ widget, actions }: SectionProps) {
  switch (widget.type) {
    case "SensorGraph":
    case "MultiSensorComparison":
      return <GraphSettings widget={widget} actions={actions} />;
    case "StatValue":
      return <StatValueSettings widget={widget} actions={actions} />;
    case "Gauge":
      return <GaugeSettings widget={widget} actions={actions} />;
    case "ProductionStatus":
      return <ProductionStatusSettings widget={widget} actions={actions} />;
    case "ProductionPlan":
      return <ProductionPlanSettings widget={widget} actions={actions} />;
    case "AlarmAlert":
      return (
        <Section title="表示するアラーム">
          <p className="text-sm text-gray-500">発生中・確認待ちのアラームを一覧で表示します。設定する項目はありません。</p>
        </Section>
      );
    default:
      return (
        <Section title="未対応の種類">
          <p className="text-sm text-gray-500">この種類のウィジェットは、ここでは設定できません。</p>
        </Section>
      );
  }
}

/** センサー1つ用の欄（数値・稼働ステータス・生産管理） */
function SingleSensorField({ widget, actions, suited }: SectionProps & { suited: "measure" | "count" | "state" }) {
  const ids = widget.sensorId ? [widget.sensorId] : [];
  const set = (sensor: Sensor) => void actions.assign(widget, sensor, "replace");
  return (
    <Section title="センサー">
      <SensorField
        sensorIds={ids}
        multiple={false}
        suited={suited}
        onAdd={set}
        onReplace={set}
        onRemove={() => void actions.patch(widget, { sensorId: null })}
      />
    </Section>
  );
}

const RANGE_OPTIONS = [
  { value: 0, label: "全体" },
  { value: 1, label: "1時間" },
  { value: 6, label: "6時間" },
  { value: 24, label: "24時間" },
] as const;

const LINE_SHAPE_OPTIONS: ReadonlyArray<{ value: LineShape; label: string }> = [
  { value: "smooth", label: "なめらか" },
  { value: "linear", label: "直線" },
  { value: "step", label: "階段" },
];
const LEGEND_OPTIONS: ReadonlyArray<{ value: LegendPosition; label: string }> = [
  { value: "bottom", label: "下" },
  { value: "right", label: "右" },
  { value: "off", label: "なし" },
];
const AGGREGATION_OPTIONS: ReadonlyArray<{ value: Aggregation; label: string }> = [
  { value: "avg", label: "平均" },
  { value: "max", label: "最大" },
  { value: "min", label: "最小" },
];
const REFRESH_LABEL: Record<(typeof REFRESH_SECONDS_OPTIONS)[number], string> = { 10: "10秒", 30: "30秒", 60: "1分", 300: "5分" };
const REFRESH_OPTIONS = REFRESH_SECONDS_OPTIONS.map((seconds) => ({ value: seconds, label: REFRESH_LABEL[seconds] }));
const AXIS_MODE_OPTIONS: ReadonlyArray<{ value: AxisMode; label: string }> = [
  { value: "shared", label: "実際の値" },
  { value: "normalized", label: "0〜100%" },
];
const STACK_OPTIONS: ReadonlyArray<{ value: StackMode; label: string }> = [
  { value: "none", label: "しない" },
  { value: "normal", label: "積み上げ" },
  { value: "percent", label: "100%" },
];
const THRESHOLD_OPTIONS: ReadonlyArray<{ value: ThresholdMode; label: string }> = [
  { value: "off", label: "なし" },
  { value: "line", label: "線" },
  { value: "area", label: "帯" },
  { value: "both", label: "両方" },
];

function GraphSettings({ widget, actions }: SectionProps) {
  const ids = graphSensorIds(widget);
  const config = widget.config;
  const style = graphStyle(config);
  const options = graphDataOptions(config, ids.length);
  // 縦軸を手動で決められるのは、実際の値で描くとき（0〜100% や 100% 積み上げでは、軸が決まっている）
  const axisIsFixed = options.axisMode === "normalized" || options.stack === "percent";
  // 縦軸は、値があれば手動。値を入れる前でも入力欄を出し続けるため、「手動にした」操作だけ覚えておく
  // （ウィジェットを切り替えたときは、SettingsPanel の key で作り直されるので、前のウィジェットの状態は引き継がない）
  const [pickedManual, setPickedManual] = useState(false);
  const manualAxis = pickedManual || config.yAxisMin !== undefined || config.yAxisMax !== undefined;

  // どちらも最新のウィジェットから作る（連続で押したときに、古い表示のまま上書きしないため）
  const removeAt = (index: number) =>
    void actions.patchFromLatest(widget, (latest) => {
      const latestIds = graphSensorIds(latest);
      const keep = latestIds.map((_, i) => i).filter((i) => i !== index);
      return graphSensorPatch(latest, keep.map((i) => latestIds[i]), keep);
    });
  const recolor = (index: number) =>
    void actions.patchFromLatest(widget, (latest) => {
      const colors = graphSensorIds(latest).map((_, i) => graphColor(latest, i));
      colors[index] = nextGraphColor(colors[index]);
      return { config: { ...latest.config, colors } };
    });
  const axisChange = (key: "yAxisMin" | "yAxisMax", value: number | null) =>
    changeConfig(actions, widget, { [key]: value ?? undefined });

  return (
    <>
      <Section title="センサー（複数OK）" note="丸い色をクリックすると線の色が変わります">
        <SensorField
          sensorIds={ids}
          multiple
          suited="measure"
          colorOf={(i) => graphColor(widget, i)}
          onRecolor={recolor}
          onAdd={(sensor) => void actions.assign(widget, sensor, "add")}
          onReplace={(sensor) => void actions.assign(widget, sensor, "replace")}
          onRemove={removeAt}
        />
      </Section>
      <Section title="グラフの形">
        <Segmented
          label="グラフの形"
          value={config.graphType ?? "line"}
          options={[
            { value: "line", label: "線" },
            { value: "area", label: "面" },
            { value: "bar", label: "棒" },
          ]}
          onChange={(graphType) => void changeConfig(actions, widget, { graphType })}
        />
      </Section>
      <Section title="期間" note="「全体」は、画面上部の時間の操作と同じ期間にします">
        <Segmented
          label="期間"
          value={config.rangeHours ?? 0}
          options={RANGE_OPTIONS}
          onChange={(hours) => void changeConfig(actions, widget, { rangeHours: hours === 0 ? undefined : hours })}
        />
      </Section>
      {!axisIsFixed && (
        <Section title="縦軸">
          <Toggle
            label="自動で合わせる"
            checked={!manualAxis}
            onChange={(auto) => {
              setPickedManual(!auto);
              if (auto) void changeConfig(actions, widget, { yAxisMin: undefined, yAxisMax: undefined });
            }}
          />
          {manualAxis && (
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs text-gray-500">
                最小
                <NumberField label="縦軸の最小" value={config.yAxisMin ?? null} allowEmpty placeholder="自動" onCommit={(v) => void axisChange("yAxisMin", v)} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-500">
                最大
                <NumberField label="縦軸の最大" value={config.yAxisMax ?? null} allowEmpty placeholder="自動" onCommit={(v) => void axisChange("yAxisMax", v)} />
              </label>
            </div>
          )}
        </Section>
      )}
      <Section title="データのまとめ方" note="グラフは、期間を細かい区間に分けて描きます。最大や最小を選ぶと、一瞬の山や谷を見逃しにくくなります">
        <Segmented
          label="区間の値"
          value={options.aggregation}
          options={AGGREGATION_OPTIONS}
          onChange={(aggregation) => void changeConfig(actions, widget, { aggregation })}
        />
        <div className="text-xs text-gray-500">自動で更新する間隔（長くすると、横軸の動きも遅くなります）</div>
        <Segmented
          label="更新間隔"
          value={options.refreshMs / 1000}
          options={REFRESH_OPTIONS}
          onChange={(refreshSeconds) => void changeConfig(actions, widget, { refreshSeconds })}
        />
      </Section>
      {ids.length > 1 && (
        <Section title="複数センサーの重ね方" note="単位の違うセンサーを同じ高さで比べるときは「0〜100%」。積み上げは、単位が同じセンサー向けです">
          <div className="text-xs text-gray-500">縦軸</div>
          <Segmented
            label="縦軸のモード"
            value={options.axisMode}
            options={AXIS_MODE_OPTIONS}
            onChange={(axisMode) => void changeConfig(actions, widget, { axisMode })}
          />
          {options.stackable && (
            <>
              <div className="text-xs text-gray-500">積み上げ</div>
              <Segmented
                label="積み上げ"
                value={options.stack}
                options={STACK_OPTIONS}
                onChange={(stack) => void changeConfig(actions, widget, { stack })}
              />
            </>
          )}
        </Section>
      )}
      <Section title="線の見た目">
        {(config.graphType ?? "line") !== "bar" && (
          <Segmented
            label="線の形"
            value={config.lineShape ?? defaultLineShape(config)}
            options={LINE_SHAPE_OPTIONS}
            onChange={(lineShape) => void changeConfig(actions, widget, { lineShape })}
          />
        )}
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          線の太さ
          <NumberField
            label="線の太さ"
            value={style.lineWidth}
            min={0.5}
            max={MAX_LINE_WIDTH}
            step={0.5}
            unit="px"
            onCommit={(v) => void changeConfig(actions, widget, { lineWidth: v ?? undefined })}
          />
        </label>
        {(config.graphType ?? "line") === "area" && (
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            塗りの濃さ
            <NumberField
              label="塗りの濃さ"
              value={Math.round(style.fillOpacity * 100)}
              min={0}
              max={100}
              step={10}
              unit="%"
              onCommit={(v) => void changeConfig(actions, widget, { fillOpacity: v === null ? undefined : v / 100 })}
            />
          </label>
        )}
        <Toggle label="点を表示" checked={style.showPoints} onChange={(showPoints) => void changeConfig(actions, widget, { showPoints })} />
      </Section>
      <Section title="目盛りと表示">
        <Toggle label="目盛りの線" checked={style.showGrid} onChange={(showGrid) => void changeConfig(actions, widget, { showGrid })} />
        <Toggle label="ツールチップ（なぞると値が出る）" checked={style.showTooltip} onChange={(showTooltip) => void changeConfig(actions, widget, { showTooltip })} />
        {ids.length > 1 && (
          <>
            <div className="text-xs text-gray-500">凡例の場所</div>
            <Segmented
              label="凡例の場所"
              value={style.legendPosition}
              options={LEGEND_OPTIONS}
              onChange={(legendPosition) => void changeConfig(actions, widget, { legendPosition })}
            />
          </>
        )}
      </Section>
      <Section title="しきい値" note="センサー1つのときに、軽故障・重故障を線や色の帯で重ねます">
        {ids.length === 1 ? (
          <Segmented
            label="しきい値の表示"
            value={thresholdMode(config)}
            options={THRESHOLD_OPTIONS}
            // 古い設定の showThresholds は、thresholdMode に置き換わるので消す
            onChange={(mode) => void changeConfig(actions, widget, { thresholdMode: mode, showThresholds: undefined })}
          />
        ) : (
          <p className="text-sm text-gray-400">センサーを1つにすると使えます</p>
        )}
      </Section>
    </>
  );
}

function GaugeSettings({ widget, actions }: SectionProps) {
  const config = widget.config;
  // 最小・最大は、両方そろったときだけ手動になる（片方だけだと、自動のまま）
  return (
    <>
      <SingleSensorField widget={widget} actions={actions} suited="measure" />
      <Section title="目盛りの範囲" note="空欄なら、しきい値と現在値から自動で決めます。最小と最大の両方を入れると、その範囲で固定します">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            最小
            <NumberField label="目盛りの最小" value={config.gaugeMin ?? null} allowEmpty placeholder="自動" onCommit={(v) => void changeConfig(actions, widget, { gaugeMin: v ?? undefined })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            最大
            <NumberField label="目盛りの最大" value={config.gaugeMax ?? null} allowEmpty placeholder="自動" onCommit={(v) => void changeConfig(actions, widget, { gaugeMax: v ?? undefined })} />
          </label>
        </div>
        {config.gaugeMin !== undefined && config.gaugeMax !== undefined && config.gaugeMin >= config.gaugeMax && (
          <p role="alert" className="text-xs text-red-600">最小は、最大より小さくしてください（いまは、自動の範囲で表示しています）</p>
        )}
      </Section>
      <Section title="小数点以下">
        <NumberField
          label="小数点以下の桁数"
          value={config.decimals ?? 1}
          min={0}
          max={6}
          step={1}
          unit="桁"
          onCommit={(v) => void changeConfig(actions, widget, { decimals: v ?? 1 })}
        />
      </Section>
    </>
  );
}

function StatValueSettings({ widget, actions }: SectionProps) {
  return (
    <>
      <SingleSensorField widget={widget} actions={actions} suited="measure" />
      <Section title="小数点以下">
        <NumberField
          label="小数点以下の桁数"
          value={widget.config.decimals ?? 1}
          min={0}
          max={6}
          step={1}
          unit="桁"
          onCommit={(v) => void changeConfig(actions, widget, { decimals: v ?? 1 })}
        />
      </Section>
      <Section title="推移の表示期間" note="下の小さな推移線に使う期間です">
        <NumberField
          label="推移の表示期間（時間）"
          value={widget.config.timeRangeHours ?? 1}
          min={0.1}
          max={720}
          step={1}
          unit="時間"
          onCommit={(v) => void changeConfig(actions, widget, { timeRangeHours: v ?? 1 })}
        />
      </Section>
    </>
  );
}

function ProductionStatusSettings({ widget, actions }: SectionProps) {
  return (
    <>
      <SingleSensorField widget={widget} actions={actions} suited="state" />
      <Section title="稼働とみなす値" note="最新の値がこれを超えたら「稼働中」と表示します">
        <NumberField
          label="稼働中とみなす値"
          value={widget.config.onThreshold ?? 0}
          onCommit={(v) => void changeConfig(actions, widget, { onThreshold: v ?? 0 })}
        />
      </Section>
      <Section title="本日の生産目標数" note="空欄なら、達成率は表示しません">
        <NumberField
          label="本日の生産目標数"
          value={widget.config.dailyTarget ?? null}
          min={0}
          allowEmpty
          placeholder="未設定"
          onCommit={(v) => void changeConfig(actions, widget, { dailyTarget: v ?? undefined })}
        />
      </Section>
    </>
  );
}

function ProductionPlanSettings({ widget, actions }: SectionProps) {
  const config = widget.config;
  const schedule = scheduleFromConfig(config);

  // 開始を終了以降にしたときは、終了を開始の1時間後に直す（稼働時間が 0 になるのを防ぐ）
  const changeStart = (hour: number) =>
    actions.patchFromLatest(widget, (latest) => ({
      config: {
        ...latest.config,
        workStartHour: hour,
        workEndHour: Math.max(scheduleFromConfig(latest.config).endHour, hour + 1),
      },
    }));

  return (
    <>
      <SingleSensorField widget={widget} actions={actions} suited="count" />
      <Section title="1日の目標" note="ここだけ決めれば使えます。残りは初期値のままで大丈夫です">
        <NumberField
          label="1日の目標"
          value={config.dailyTarget ?? null}
          min={0}
          step={50}
          unit="個"
          onCommit={(v) => void changeConfig(actions, widget, { dailyTarget: v ?? undefined })}
        />
      </Section>
      <Section title="勤務時間">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            開始
            <NumberField label="勤務開始（時）" value={schedule.startHour} min={0} max={23} onCommit={(v) => void changeStart(v ?? 8)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            終了
            <NumberField
              label="勤務終了（時）"
              value={schedule.endHour}
              min={schedule.startHour + 1}
              max={24}
              onCommit={(v) => void changeConfig(actions, widget, { workEndHour: v ?? 17 })}
            />
          </label>
        </div>
        <div className="text-xs text-gray-500">昼休み（12:00〜）</div>
        <Segmented
          label="昼休み"
          value={schedule.breakMinutes}
          options={[
            { value: 0, label: "なし" },
            { value: 45, label: "45分" },
            { value: 60, label: "60分" },
          ]}
          onChange={(breakMinutes) => void changeConfig(actions, widget, { breakMinutes })}
        />
      </Section>
      {(config.dailyTarget ?? 0) > 0 && (
        <div className="py-3">
          <p className="rounded-lg bg-gray-50 px-2.5 py-2 text-xs text-gray-500">
            計画は<b className="text-gray-900">目標 ÷ 稼働時間</b>で自動作成します。
            <br />
            稼働 <b className="text-gray-900">{(totalWorkMinutes(schedule) / 60).toFixed(1)}</b> 時間 → 1時間あたり{" "}
            <b className="text-gray-900">{Math.round(planPerWorkHour(config.dailyTarget ?? 0, schedule)).toLocaleString("ja-JP")}</b> 個
          </p>
        </div>
      )}
      <Section title="表示する項目">
        <Toggle label="時間別の実績グラフ" checked={config.showHourly ?? true} onChange={(v) => void changeConfig(actions, widget, { showHourly: v })} />
        <Toggle label="終業時の見込み" checked={config.showForecast ?? true} onChange={(v) => void changeConfig(actions, widget, { showForecast: v })} />
        <Toggle label="稼働率と停止時間" checked={config.showUptime ?? true} onChange={(v) => void changeConfig(actions, widget, { showUptime: v })} />
      </Section>
    </>
  );
}
