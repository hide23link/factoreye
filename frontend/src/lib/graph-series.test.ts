import { describe, expect, it } from "vitest";

import { RAW_SUFFIX, bucketValue, buildRows, normalizeRows, rawValueOf } from "./graph-series";

const bucket = (start: string, min: number, avg: number, max: number) => ({ start, min, avg, max });

describe("bucketValue", () => {
  const b = bucket("2024-01-01T00:00:00Z", 1, 5, 9);
  it("平均・最大・最小を選べる", () => {
    expect(bucketValue(b, "avg")).toBe(5);
    expect(bucketValue(b, "max")).toBe(9);
    expect(bucketValue(b, "min")).toBe(1);
  });
});

describe("buildRows", () => {
  const t0 = "2024-01-01T00:00:00.000Z";
  const t1 = "2024-01-01T00:01:00.000Z";
  const half = 30_000;

  it("区間の中央の時刻ごとに、センサーの値を1行にまとめる（時刻順）", () => {
    const rows = buildRows(
      [
        { sensorId: "a", bucketSeconds: 60, buckets: [bucket(t1, 0, 2, 4), bucket(t0, 0, 1, 3)] },
        { sensorId: "b", bucketSeconds: 60, buckets: [bucket(t0, 0, 10, 30)] },
      ],
      "avg",
    );
    expect(rows).toEqual([
      { time: new Date(t0).getTime() + half, a: 1, b: 10 },
      { time: new Date(t1).getTime() + half, a: 2 },
    ]);
  });

  it("最大・最小を選ぶと、その値が入る", () => {
    const input = [{ sensorId: "a", bucketSeconds: 60, buckets: [bucket(t0, 0, 1, 3)] }];
    expect(buildRows(input, "max")[0].a).toBe(3);
    expect(buildRows(input, "min")[0].a).toBe(0);
  });

  it("fillGaps: 値が無い行は直前の値、先頭の欠けは 0 で埋める（積み上げ用）", () => {
    const rows = buildRows(
      [
        { sensorId: "a", bucketSeconds: 60, buckets: [bucket(t0, 0, 1, 1), bucket(t1, 0, 2, 2)] },
        { sensorId: "b", bucketSeconds: 60, buckets: [bucket(t1, 0, 7, 7)] },
      ],
      "avg",
      { fillGaps: true },
    );
    expect(rows.map((r) => r.b)).toEqual([0, 7]);
    const withTail = buildRows(
      [
        { sensorId: "a", bucketSeconds: 60, buckets: [bucket(t0, 0, 1, 1)] },
        { sensorId: "b", bucketSeconds: 60, buckets: [bucket(t0, 0, 5, 5), bucket(t1, 0, 6, 6)] },
      ],
      "avg",
      { fillGaps: true },
    );
    // a は途中で止まった（最後のデータ以降）ので、停止後を実際の値のように補わず 0 にする
    expect(withTail.map((r) => r.a)).toEqual([1, 0]);
  });

  it("fillGaps: 途中の欠けは直前の値で埋める", () => {
    const t2 = "2024-01-01T00:02:00.000Z";
    const rows = buildRows(
      [
        { sensorId: "a", bucketSeconds: 60, buckets: [bucket(t0, 0, 4, 4), bucket(t2, 0, 8, 8)] },
        { sensorId: "b", bucketSeconds: 60, buckets: [bucket(t0, 0, 1, 1), bucket(t1, 0, 1, 1), bucket(t2, 0, 1, 1)] },
      ],
      "avg",
      { fillGaps: true },
    );
    expect(rows.map((r) => r.a)).toEqual([4, 4, 8]);
  });

  it("データが無いときは空", () => {
    expect(buildRows([], "avg")).toEqual([]);
  });
});

describe("normalizeRows", () => {
  it("センサーごとに最小〜最大を 0〜100 にし、元の値も残す", () => {
    const rows = normalizeRows(
      [
        { time: 1, a: 10, b: 1000 },
        { time: 2, a: 20, b: 3000 },
        { time: 3, a: 30, b: 2000 },
      ],
      ["a", "b"],
    );
    expect(rows.map((r) => r.a)).toEqual([0, 50, 100]);
    expect(rows.map((r) => r.b)).toEqual([0, 100, 50]);
    expect(rows[1][`a${RAW_SUFFIX}`]).toBe(20);
    expect(rows[1][`b${RAW_SUFFIX}`]).toBe(3000);
  });

  it("値が変わらないセンサーは真ん中（50）。欠けた行はそのまま", () => {
    const rows = normalizeRows([{ time: 1, a: 5 }, { time: 2, a: 5 }, { time: 3 } as never], ["a"]);
    expect(rows.map((r) => r.a)).toEqual([50, 50, undefined]);
  });

  it("元の行は書き換えない", () => {
    const original = [{ time: 1, a: 1 }, { time: 2, a: 3 }];
    normalizeRows(original, ["a"]);
    expect(original).toEqual([{ time: 1, a: 1 }, { time: 2, a: 3 }]);
  });
});

describe("rawValueOf", () => {
  it("0〜100% に換算した行から、そのセンサーの元の値を取り出す", () => {
    expect(rawValueOf({ dataKey: "a", payload: { a: 50, [`a${RAW_SUFFIX}`]: 20 } })).toBe(20);
  });
  it("元の値が無い（換算していない）ときは undefined", () => {
    expect(rawValueOf({ dataKey: "a", payload: { a: 50 } })).toBeUndefined();
    expect(rawValueOf({ dataKey: "a" })).toBeUndefined();
  });
});
