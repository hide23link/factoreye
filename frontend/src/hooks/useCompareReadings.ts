/**
 * 昨日・先週の比較に使う、間引きデータの取得。今の線と同じ API を、範囲をずらして取る。
 *
 * - 比較側は過去のデータなので、取り直さない（live = false）。範囲は compareFetchRange で丸めて、取得の数を増やさない。
 * - 昨日 → 先週と切り替えた直後は、前の種類のデータ（useDownsampledReadings の keepPreviousData）を使わず、空にする。
 *   前のデータを使うと、昨日のデータが先週のずらしで描かれてしまうため。
 * - 取得に失敗しても、今の線には影響しない（data が無いだけ）。
 *
 * 【誰が使うか】TrendStackWidget の行、SensorGraphWidget。
 * 【引数】sensorId = センサー。range = 今の表示範囲。mode = 比較の種類（なし なら取らない）。stepMs = グラフの 1 区間の長さ。
 */
import { useEffect, useMemo, useRef } from "react";

import { compareFetchRange, type CompareMode } from "../lib/compare-range";
import { useDownsampledReadings } from "./queries";

export function useCompareReadings(sensorId: string | null, range: { from: number; to: number }, mode: CompareMode, buckets: number, stepMs: number) {
  const fetchRange = useMemo(() => compareFetchRange(range, mode, stepMs), [range, mode, stepMs]);
  const { data, isPlaceholderData } = useDownsampledReadings(mode === "none" ? null : sensorId, fetchRange, buckets, false);
  // 最後に本物のデータが届いたときの比較の種類。それと違う種類のあいだは、前のデータ（placeholder）を使わない
  const settledMode = useRef<CompareMode>("none");
  useEffect(() => {
    if (data && !isPlaceholderData) settledMode.current = mode;
  }, [data, isPlaceholderData, mode]);
  if (mode === "none" || !data) return undefined;
  return isPlaceholderData && settledMode.current !== mode ? undefined : data;
}
