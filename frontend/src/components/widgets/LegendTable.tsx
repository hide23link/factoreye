/**
 * 複数センサー比較グラフの下に出す「凡例の表」。センサーごとに 1 行で、名前（線の色の見本つき）・値・最小・最大・平均を並べる。
 * 値は、カーソルがあればその時刻の値、なければ最新の値（呼び出し側が items の value に入れる）。
 * 行を押すと、その 1 本だけを表示し、ほかの線を薄くする（もう一度押すと戻る。Shift・Ctrl・Cmd を押しながらだと複数）。
 * 名前はボタンなので、Enter・Space でも操作できる（aria-pressed つき）。状態は保存しない（親が持つ）。スマホ幅（sm 未満）では「平均」の列を隠す。
 *
 * 【誰が使うか】MultiSensorComparisonWidget（リンクの画面では出さない）。
 * 【引数（props）】
 *   items = 行ごとの {センサー ID・名前・線の色・単位・表示する値・最小・最大・平均}。数値は線と同じデータから計算したもの
 *   selected = 表示中（強調中）のセンサー ID。空なら全部表示
 *   onToggle = 行を押したとき。(センサー ID, 複数選択か) を渡す
 *   decimals = 小数の桁数（未指定なら有効数字 4 桁）
 *   atCursor = 値の列がカーソルの時刻のものか（見出しの文字に使う）
 */
import { formatYTick } from "./graph-parts";
import { isDimmed } from "../../lib/legend-table";

export interface LegendTableItem {
  sensorId: string;
  name: string;
  color: string;
  unit: string;
  /** 表示する値（カーソルの時刻、または最新）。無ければ undefined */
  value: number | undefined;
  /** 表示期間の最小・最大・平均。データが無ければ undefined */
  stats: { min: number; max: number; average: number } | undefined;
}

export function LegendTable({
  items,
  selected,
  onToggle,
  decimals,
  atCursor,
}: {
  items: ReadonlyArray<LegendTableItem>;
  selected: ReadonlyArray<string>;
  onToggle: (sensorId: string, multi: boolean) => void;
  decimals?: number;
  atCursor: boolean;
}) {
  const format = (value: number | undefined) =>
    value === undefined ? "---" : decimals === undefined ? formatYTick(value) : value.toFixed(decimals);
  const head = "whitespace-nowrap px-1.5 py-0.5 text-right font-normal text-gray-500";
  const cell = "whitespace-nowrap px-1.5 py-0.5 text-right font-num text-gray-900";

  return (
    <div className="mt-1 max-h-[40%] shrink-0 overflow-y-auto text-[11px]" data-testid="legend-table">
      <table className="w-full border-collapse" aria-label="凡例の表">
        <thead>
          <tr className="border-b border-gray-200">
            <th scope="col" className="px-1.5 py-0.5 text-left font-normal text-gray-500">
              名前
            </th>
            <th scope="col" className={head}>
              {atCursor ? "値（カーソル）" : "値（最新）"}
            </th>
            <th scope="col" className={head}>
              最小
            </th>
            <th scope="col" className={head}>
              最大
            </th>
            <th scope="col" className={`${head} hidden sm:table-cell`}>
              平均
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const dimmed = isDimmed(selected, item.sensorId);
            const pressed = selected.includes(item.sensorId);
            return (
              <tr
                key={item.sensorId}
                className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
                style={{ opacity: dimmed ? 0.45 : 1 }}
                // 行のどこを押しても切り替える。名前のボタンの押下（Enter・Space を含む）も、ここに伝わる
                onClick={(e) => onToggle(item.sensorId, e.shiftKey || e.ctrlKey || e.metaKey)}
              >
                <td className="w-full min-w-[5rem] max-w-0 px-1.5 py-0.5 text-left text-gray-700">
                  <button
                    type="button"
                    aria-pressed={pressed}
                    aria-label={`${item.name} だけ表示する`}
                    className="flex w-full items-center gap-1.5 text-left"
                  >
                    <span
                      data-testid="legend-swatch"
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                      style={{ background: item.color }}
                      aria-hidden="true"
                    />
                    <span className="truncate" title={item.name}>
                      {item.name}
                    </span>
                    {item.unit && <span className="shrink-0 text-gray-500">{item.unit}</span>}
                  </button>
                </td>
                <td className={`${cell} font-bold`}>{format(item.value)}</td>
                <td className={cell}>{format(item.stats?.min)}</td>
                <td className={cell}>{format(item.stats?.max)}</td>
                <td className={`${cell} hidden sm:table-cell`}>{format(item.stats?.average)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
