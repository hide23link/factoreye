/**
 * センサーのしきい値を、色の帯（緑=正常、橙=軽故障、赤=重故障）で見せる小さなバー。
 * 数字の表（軽故障・重故障の下限/上限）だけでは分かりにくい「どこから危ないか」を、ひと目で分かるようにする。
 *
 * 【誰が使うか】SensorSettingsPanel（一覧の各行の名前の下）。
 * 【引数（props）】sensor = しきい値を持つセンサー。
 */
import { thresholdZones } from "../../lib/threshold-zones";
import type { Sensor } from "../../types";

const ZONE_CLASS = { normal: "bg-green-500", warning: "bg-amber-400", critical: "bg-red-500" } as const;
const ZONE_LABEL = { normal: "正常", warning: "軽故障", critical: "重故障" } as const;

/** 帯の説明（読み上げ・マウスを乗せたとき）。例: 「重故障 〜5」「正常 5〜80」 */
function describeZone(zone: { severity: keyof typeof ZONE_LABEL; from: number | null; to: number | null }): string {
  return `${ZONE_LABEL[zone.severity]} ${zone.from ?? ""}〜${zone.to ?? ""}`;
}

export function ThresholdBar({ sensor }: { sensor: Sensor }) {
  const zones = thresholdZones(sensor);
  if (!zones) return <div className="mt-1 text-[11px] font-normal text-gray-400">しきい値なし</div>;

  return (
    <div role="img" aria-label={`しきい値: ${zones.map(describeZone).join("、")}`} className="mt-1 flex h-1.5 w-32 overflow-hidden rounded-full">
      {zones.map((zone, i) => (
        <span
          key={i}
          title={describeZone(zone)}
          // 帯の境目に白い線を入れる（色の違いだけに頼らず、区切りが分かるように）
          className={`${ZONE_CLASS[zone.severity]} ${i > 0 ? "border-l border-white" : ""}`}
          style={{ width: `${zone.share * 100}%` }}
        />
      ))}
    </div>
  );
}
