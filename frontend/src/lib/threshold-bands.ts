/**
 * しきい値を超えている区間を、連続した 1 つの「帯」にまとめる計算（グラフに縦の帯を重ねるための元データ）。
 *
 * 判定は、間引きの区間の「最高（上限側）・最低（下限側）」で行う。平均で判定すると、10 分の区間に 1 秒だけ警報値があっても
 * 平均が超えなければ帯が出ず、行の「最高」札（区間の最高）と食い違うため（警報の見落としを防ぐ）。
 * 線の色の切り替え（overPath）は線の値（平均など）のままなので、帯の端と線の色の変わり目は一致しないことがある。
 * 帯の端は、区間の中央の時刻（線の点と同じ時刻）。1 区間だけ超えた帯は幅 0 になり、描くときに幅は最低 2px にする。
 *
 * 【誰が使うか】components/widgets/TrendStackWidget.tsx（計器グラフの各行）と SensorGraphWidget.tsx（センサーグラフ）。
 * 【引数】samples = 区間ごとの最高・最低（toBandSamples で作る。時刻の昇順）。limits = trendLimits(sensor) の結果。
 * gapMs = これより区間が離れたら受信なしとみなして帯を分ける。値が数でない区間は、読み飛ばす（帯を切らない）。
 * 例: 上限 50（警報）で 11:00（最高 30）・11:10（最高 95・平均 32）・11:20（最高 30）なら、
 *     [{ startMs: 11:10, endMs: 11:10, level: "critical", side: "max", extreme: 95 }]
 */
import { bucketMidTime, levelOf, type TrendLimit } from "./trend-stack";

/** 帯の段階。注意（軽故障）は橙、警報（重故障）は赤で描く */
export type BandLevel = "warning" | "critical";

/** 区間 1 つの最高・最低（time は区間の中央の時刻） */
export interface BandSample {
  time: number;
  max: number;
  min: number;
}

/** 超えた区間 1 つ */
export interface AlarmBand {
  startMs: number;
  endMs: number;
  /** 区間の中の最悪の段階 */
  level: BandLevel;
  /** どちら側を超えたか（上限側＝max、下限側＝min）。extreme が最高なら max、最低なら min */
  side: "max" | "min";
  /** 区間の中でいちばん深く超えた値（上限側は最高、下限側は最低） */
  extreme: number;
}

/** 間引きの区間を、帯の判定に使う形にする（時刻は線の点と同じ。endTime より後にはしない） */
export function toBandSamples(
  buckets: ReadonlyArray<{ start: string; max: number; min: number }>,
  bucketSeconds: number,
  endTime?: number,
): BandSample[] {
  return buckets.map((bucket) => ({
    time: bucketMidTime(new Date(bucket.start).getTime(), bucketSeconds, endTime),
    max: bucket.max,
    min: bucket.min,
  }));
}

/** 区間の、いちばん深い超え方（超えていなければ amount が 0）。上限側は最高、下限側は最低で見る */
function worstExcess(sample: BandSample, limits: ReadonlyArray<TrendLimit>): { amount: number; side: "max" | "min"; value: number } {
  let best = { amount: 0, side: "max" as "max" | "min", value: sample.max };
  for (const limit of limits) {
    const value = limit.side === "max" ? sample.max : sample.min;
    const amount = limit.side === "max" ? value - limit.value : limit.value - value;
    if (amount > best.amount) best = { amount, side: limit.side, value };
  }
  return best;
}

/** 区間の段階。上限側は最高、下限側は最低を、線の色と同じ levelOf で判定し、悪いほうを取る */
function sampleLevel(sample: BandSample, limits: ReadonlyArray<TrendLimit>): "critical" | "warning" | "normal" {
  const upper = levelOf(sample.max, limits.filter((limit) => limit.side === "max"));
  const lower = levelOf(sample.min, limits.filter((limit) => limit.side === "min"));
  if (upper === "critical" || lower === "critical") return "critical";
  return upper === "warning" || lower === "warning" ? "warning" : "normal";
}

/** しきい値を超えている連続した区間の一覧（時刻の昇順）。しきい値が無い・超えていなければ空 */
export function computeBands(samples: ReadonlyArray<BandSample>, limits: ReadonlyArray<TrendLimit>, gapMs = Infinity): AlarmBand[] {
  if (limits.length === 0) return [];
  const bands: AlarmBand[] = [];
  let current: (AlarmBand & { depth: number }) | null = null;
  let previousTime = -Infinity;

  for (const sample of samples) {
    // 値が数でない区間（欠け）は読み飛ばす。帯を切るのは、受信なし（gapMs 以上の間）と、超えていない区間だけ
    if (!Number.isFinite(sample.max) || !Number.isFinite(sample.min)) continue;
    const level = sampleLevel(sample, limits);
    if (level === "normal") {
      current = null;
      previousTime = sample.time;
      continue;
    }
    const excess = worstExcess(sample, limits);
    const continues = current !== null && sample.time - previousTime <= gapMs;
    if (!continues || current === null) {
      current = { startMs: sample.time, endMs: sample.time, level, side: excess.side, extreme: excess.value, depth: excess.amount };
      bands.push(current);
    } else {
      current.endMs = sample.time;
      if (level === "critical") current.level = "critical";
      // いちばん深く超えた区間の値と側を、帯の「最高・最低」にする
      if (excess.amount > current.depth) {
        current.depth = excess.amount;
        current.side = excess.side;
        current.extreme = excess.value;
      }
    }
    previousTime = sample.time;
  }
  // depth は計算用なので、返す形からは外す
  return bands.map(({ startMs, endMs, level, side, extreme }) => ({ startMs, endMs, level, side, extreme }));
}

/**
 * 時刻（カーソル）がある帯。無ければ null。
 * toleranceMs: 帯の端からこの長さまでは、帯の中とみなす（カーソルは 1 区間に丸めるので、1 点だけの帯にも触れるように）。
 */
export function bandAt(bands: ReadonlyArray<AlarmBand>, time: number, toleranceMs = 0): AlarmBand | null {
  return bands.find((band) => time >= band.startMs - toleranceMs && time <= band.endMs + toleranceMs) ?? null;
}

/** 帯の説明の文字。例: 「警報 11:42〜12:58 最高 89.2」「注意 03:10 最低 4.1」（1 点だけの帯は時刻を 1 つだけ出す） */
export function describeBand(band: AlarmBand, formatTime: (ms: number) => string, formatValue: (value: number) => string): string {
  const name = band.level === "critical" ? "警報" : "注意";
  const range = band.startMs === band.endMs ? formatTime(band.startMs) : `${formatTime(band.startMs)}〜${formatTime(band.endMs)}`;
  return `${name} ${range} ${band.side === "max" ? "最高" : "最低"} ${formatValue(band.extreme)}`;
}
