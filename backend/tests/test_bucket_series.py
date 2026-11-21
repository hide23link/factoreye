"""間引き結果の JSON（app/bucket_series.py）が、Pydantic のモデルの出力と 1 文字も違わないこと。

series_json は、速くするためにモデルを経由せず文字列を組み立てる。基準は BucketSeries.to_model()
の model_dump_json(by_alias=True)（以前の応答の作り方）。区間の開始時刻・マイクロ秒の丸め・
float の表記・null・空の結果・日付の変わり目を、ランダムな入力で全文比較する。
"""

import random
from datetime import UTC, datetime
from uuid import uuid4

import pytest

from app.bucket_series import BucketRow, BucketSeries, batch_result_json, series_json
from app.schemas import DownsampledBatchResponse, DownsampledBatchResult

# 通常の表記・指数表記・nan・inf・負のゼロ・極端な値（Pydantic と同じ表記になること）
_AWKWARD_FLOATS = [0.0, -0.0, 1.0, 20.5, 1e15, 1e16, 1e22, 1e-4, 1e-5, 1.5e300, 5e-324]
_AWKWARD_FLOATS += [float("nan"), float("inf"), float("-inf"), 123456789.12345679, -3.0e-7]


def _expected(series: BucketSeries) -> str:
    return series.to_model().model_dump_json(by_alias=True)


def _random_rows(rng: random.Random, count: int) -> list[BucketRow]:
    rows: list[BucketRow] = []
    for index in sorted(rng.sample(range(count * 2), count)):
        low = rng.choice([rng.uniform(-100, 100), rng.choice(_AWKWARD_FLOATS)])
        avg = rng.choice([rng.uniform(-100, 100), rng.choice(_AWKWARD_FLOATS)])
        high = rng.choice([rng.uniform(-1e6, 1e6), rng.choice(_AWKWARD_FLOATS)])
        rows.append((index, low, avg, high, rng.randint(1, 10**6)))
    return rows


def test_json_equals_model_for_random_series() -> None:
    rng = random.Random(20261121)
    for _ in range(300):
        start = datetime(2026, 1, 1, tzinfo=UTC).timestamp() + rng.uniform(0, 4e8)
        if rng.random() < 0.3:
            start = float(int(start))  # 秒ちょうど
        width = rng.choice([rng.uniform(0.001, 5000), 1209.6, 120.0, 86400.0 / 7, 0.5])
        series = BucketSeries(width, start, _random_rows(rng, rng.randint(0, 60)))

        assert series_json(series) == _expected(series)


def test_microsecond_rounding_and_day_boundary() -> None:
    """マイクロ秒の四捨五入が datetime.fromtimestamp と同じで、日付・年の変わり目も正しい。"""
    midnight = datetime(2026, 12, 31, 23, 59, 59, tzinfo=UTC).timestamp()
    rows: list[BucketRow] = [(i, 1.0, 1.5, 2.0, 3) for i in range(20)]
    for width in (0.1, 0.1234565, 0.0000005, 0.3333333333, 1.0):
        series = BucketSeries(width, midnight, rows)
        assert series_json(series) == _expected(series)


def test_empty_series() -> None:
    series = BucketSeries(1209.6, 1_700_000_000.0, [])

    assert series_json(series) == '{"bucketSeconds":1209.6,"buckets":[]}'
    assert series_json(series) == _expected(series)


def test_batch_result_json_equals_model() -> None:
    sensor_id = uuid4()
    series = BucketSeries(60.0, 1_700_000_000.25, [(0, 1.0, 2.0, 3.0, 4), (2, 0.1, 0.2, 0.3, 1)])
    model = DownsampledBatchResponse(
        results=[DownsampledBatchResult(sensor_id=sensor_id, status=200, data=series.to_model())]
    )

    assert '{"results":[' + batch_result_json(sensor_id, series) + "]}" == model.model_dump_json(
        by_alias=True
    )


@pytest.mark.parametrize("status", [400, 404])
def test_failure_item_has_null_data(status: int) -> None:
    """失敗の件は、data が null のまま出る（フロントが読む形を変えない）。"""
    failure = DownsampledBatchResult(sensor_id=uuid4(), status=status, detail="x")

    assert '"data":null' in failure.model_dump_json(by_alias=True)
