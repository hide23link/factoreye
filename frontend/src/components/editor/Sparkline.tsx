/**
 * 小さな推移線（センサー棚の行と、センサー選択の行で使う）。点が2つ未満なら何も描かない。
 *
 * 【誰が使うか】EditorShelf、SensorPicker。
 */
export function Sparkline({ values, width = 40, height = 18 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <span style={{ width }} aria-hidden="true" />;
  const low = Math.min(...values);
  const range = Math.max(...values) - low || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - low) / range) * (height - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline fill="none" stroke="var(--fe-mut)" strokeWidth={1.4} points={points} />
    </svg>
  );
}
