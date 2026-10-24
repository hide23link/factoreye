/**
 * しきい値の色の帯（緑=正常、橙=軽故障、赤=重故障）の上に、いまの値の位置を印で示す、横長のバー。
 * 「危ない値まで、どれくらい余裕があるか」が、数字を読まなくても分かる。しきい値が無いセンサーには出さない（null を返す）。
 *
 * 【誰が使うか】StatValueWidget（数値の下）。
 * 【引数（props）】sensor = しきい値を持つセンサー、value = いまの値。
 */
import { gaugeFraction, gaugeRange, gaugeZones } from "../../lib/gauge";
import type { Sensor } from "../../types";

const ZONE_CLASS = { normal: "bg-green-500", warning: "bg-amber-400", critical: "bg-red-500" } as const;

export function ThresholdMeter({ sensor, value }: { sensor: Sensor; value: number }) {
  const range = gaugeRange(sensor, {}, value);
  const zones = gaugeZones(sensor, range);
  // 帯が1つだけ（しきい値が無い、または範囲の外）なら、余裕を見せる意味がないので出さない
  if (zones.length < 2) return null;
  const position = gaugeFraction(value, range) * 100;

  return (
    <div aria-hidden="true" className="relative mt-1 h-2 w-full max-w-[200px] rounded-full bg-gray-200">
      <div className="flex h-full overflow-hidden rounded-full">
        {zones.map((zone) => (
          <span
            key={`${zone.severity}-${zone.from}`}
            className={`${ZONE_CLASS[zone.severity]} opacity-70`}
            style={{ width: `${(zone.to - zone.from) * 100}%` }}
          />
        ))}
      </div>
      <i
        className="absolute -top-1 h-4 w-1 -translate-x-1/2 rounded bg-gray-900 ring-2 ring-white"
        style={{ left: `${position}%` }}
      />
    </div>
  );
}
