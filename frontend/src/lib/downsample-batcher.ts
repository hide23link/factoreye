/**
 * グラフ用の間引きの取得を、短い時間にまとめて 1 回の API にする（多グラフのダッシュボードで、
 * 同時のリクエストと DB の接続の取り合いを減らすため）。
 *
 * 【誰が使うか】lib/api.ts の fetchSensorReadingsDownsampled だけ。画面・hooks は今までどおり
 * センサー 1 本ずつ呼ぶ（queryKey・再取得・失敗の表示は変わらない）。
 * 【流れ】呼ばれた取得を windowMs の間ためる → 1 件だけなら、今までの単体 API → 2 件以上なら、
 * まとめ API（POST /api/sensors/readings/downsampled）を、chunkSize 件ずつ並列に→ 件ごとの結果で、
 * 呼んだ人それぞれの Promise を成功・失敗にする（1 件の失敗は、その件の呼び出しだけが失敗）。
 * まとめ API が無い（古いバックエンド: 404・405）ときは、単体 API に戻し、以後もまとめない。
 * 同じ取得（センサー・範囲・区間数が同じ）は、1 件にして結果を分け合う。
 */
import type { DownsampledReadings } from "./api";
import { ApiError, errorStatus } from "./errors";

/** 1 件の取得の指定。from・to は ISO 文字列 */
export interface DownsampleRequest {
  sensorId: string;
  from: string;
  to: string;
  buckets: number;
}

/** まとめ API の、1 件の結果（バックエンドの DownsampledBatchResult） */
export interface DownsampleBatchResult {
  sensorId: string;
  status: number;
  data?: DownsampledReadings | null;
  detail?: string | null;
}

/** まとめ API の 1 回の上限（バックエンドの MAX_DOWNSAMPLE_BATCH_ITEMS と同じ） */
export const MAX_BATCH_ITEMS = 50;

/** 1 回に送る件数の下限。これより小さく分けても、リクエストが増えるだけで速くならない */
export const MIN_CHUNK_ITEMS = 3;

/**
 * n 件を、何件ずつに分けて送るか。3 件以上ずつ・最大 4 本の並列にする（max(3, ceil(n/4))、上限 50）。
 * 1 本にまとめると、1 接続で順に読むぶん、空いているときに遅いため（12 件で 185 ms → 72 ms）。
 * 4 本にとどめるのは、ダッシュボードが多いときに DB の接続を取り合わないため。
 */
export const chunkSize = (n: number) => Math.min(MAX_BATCH_ITEMS, Math.max(MIN_CHUNK_ITEMS, Math.ceil(n / 4)));

/** ためる時間（ミリ秒）。同じ画面の描画で一斉に出る取得をまとめる程度に短く */
export const BATCH_WINDOW_MS = 25;

interface Waiter {
  resolve: (data: DownsampledReadings) => void;
  reject: (error: unknown) => void;
}

interface Deps {
  /** 単体 API（GET）で 1 件取る */
  fetchOne: (item: DownsampleRequest) => Promise<DownsampledReadings>;
  /** まとめ API（POST）で取る。結果は items と同じ順 */
  fetchMany: (items: DownsampleRequest[]) => Promise<DownsampleBatchResult[]>;
  windowMs?: number;
}

const keyOf = (item: DownsampleRequest) => `${item.sensorId}|${item.from}|${item.to}|${item.buckets}`;

/** まとめ API が使えない（古いバックエンド）ことを表す失敗か */
const isBatchUnsupported = (error: unknown) => {
  const status = errorStatus(error);
  return status === 404 || status === 405;
};

export function createDownsampleBatcher({ fetchOne, fetchMany, windowMs = BATCH_WINDOW_MS }: Deps) {
  // 同じ取得は、1 つの Map の項目にして、待っている人を並べる
  let queue = new Map<string, { item: DownsampleRequest; waiters: Waiter[] }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let batchUnsupported = false;

  const settle = (waiters: Waiter[], run: () => Promise<DownsampledReadings>) => {
    run().then(
      (data) => waiters.forEach((w) => w.resolve(data)),
      (error: unknown) => waiters.forEach((w) => w.reject(error)),
    );
  };

  /** 1 回分（50 件まで）をまとめ API で取り、件ごとに結果を返す */
  const sendChunk = async (entries: { item: DownsampleRequest; waiters: Waiter[] }[]) => {
    try {
      const results = await fetchMany(entries.map((entry) => entry.item));
      entries.forEach((entry, i) => {
        const result = results[i];
        if (result?.status === 200 && result.data) {
          entry.waiters.forEach((w) => w.resolve(result.data as DownsampledReadings));
          return;
        }
        const status = result?.status ?? 502;
        const error = new ApiError(status, `POST /api/sensors/readings/downsampled item failed: ${status} ${result?.detail ?? ""}`);
        entry.waiters.forEach((w) => w.reject(error));
      });
    } catch (error) {
      if (!isBatchUnsupported(error)) {
        entries.forEach((entry) => entry.waiters.forEach((w) => w.reject(error)));
        return;
      }
      batchUnsupported = true;
      entries.forEach((entry) => settle(entry.waiters, () => fetchOne(entry.item)));
    }
  };

  const flush = () => {
    timer = null;
    const entries = [...queue.values()];
    queue = new Map();
    if (entries.length === 1 || batchUnsupported) {
      entries.forEach((entry) => settle(entry.waiters, () => fetchOne(entry.item)));
      return;
    }
    // 分けた分は、順番を待たずに同時に送る（結果は件ごとに、呼んだ人へ返る）
    const size = chunkSize(entries.length);
    for (let i = 0; i < entries.length; i += size) {
      void sendChunk(entries.slice(i, i + size));
    }
  };

  /** 取得を頼む。結果は、単体 API の fetchSensorReadingsDownsampled と同じ形で返る */
  return function fetchDownsampled(item: DownsampleRequest): Promise<DownsampledReadings> {
    return new Promise<DownsampledReadings>((resolve, reject) => {
      const key = keyOf(item);
      const entry = queue.get(key);
      if (entry) entry.waiters.push({ resolve, reject });
      else queue.set(key, { item, waiters: [{ resolve, reject }] });
      if (timer === null) timer = setTimeout(flush, windowMs);
    });
  };
}
