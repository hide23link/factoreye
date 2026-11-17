/**
 * グラフの右に並べる、今の値の札（操作室の計器のように、四角で囲んだ等幅の数字）。
 * 線ごとに 1 つ。枠の色は、その線の色。センサーが 1 つなら 1 つ、複数なら縦に並べる。
 * 値は、全センサーの最新の測定値（GET /api/sensors/latest）。まだ受信が無いセンサーは「---」。
 *
 * 【誰が使うか】SensorGraphWidget（1 センサー）、MultiSensorComparisonWidget（複数）。リンクの画面では出さない。
 * 【引数（props）】items = 線ごとの {名前・色・単位・今の値}。値の桁は decimals（未指定は有効数字 4 桁）。
 */
import { formatYTick } from "./graph-parts";

export interface GraphValueItem {
  name: string;
  color: string;
  unit: string;
  /** 最新の測定値。まだ受信が無いときは undefined */
  value: number | undefined;
}

export function GraphValues({ items, decimals }: { items: ReadonlyArray<GraphValueItem>; decimals?: number }) {
  return (
    <ul className="flex w-[76px] shrink-0 flex-col justify-center gap-1.5" aria-label="今の値">
      {items.map((item) => (
        <li key={item.name} className="flex flex-col items-end">
          <span className="font-num text-[10px] text-gray-500">{item.unit}</span>
          <span
            className="max-w-full truncate rounded-sm border-[1.5px] px-1 text-right font-num text-sm font-bold text-gray-900"
            style={{ borderColor: item.color }}
            title={item.name}
          >
            {item.value === undefined ? "---" : decimals === undefined ? formatYTick(item.value) : item.value.toFixed(decimals)}
          </span>
          {items.length > 1 && (
            <span className="max-w-full truncate text-[10px] text-gray-500" title={item.name}>
              {item.name}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
