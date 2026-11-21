"""グラフ用の間引き結果（区間ごとの集計）と、その JSON の作り方。

【誰が使うか】app/readings_query.py が DB から読んだ区間の集計を BucketSeries にして返し、
app/api/sensors.py が series_json / batch_result_json で応答の JSON にする。

【なぜ Pydantic のモデルを経由しないか】7 日・500 区間・12 センサーで約 6,000 区間ある。
1 区間ごとに datetime とモデル（DownsampledBucket）を作り、再検証し、JSON にする処理は、
1 リクエストの CPU の約 4 割だった。ここでは区間の開始時刻を epoch 秒の計算だけで文字列にし、
JSON を直接組み立てる。出力は DownsampledReadings.model_dump_json(by_alias=True) と
1 文字も変わらない（tests/test_bucket_series.py が、モデルの出力と全文を比べる）。
OpenAPI の定義（response_model）は、呼び出し側のルートに残してある。
"""
import math
from datetime import UTC, date, datetime
from functools import lru_cache
from typing import NamedTuple
from uuid import UUID

from pydantic_core import to_json

from app.schemas import DownsampledBucket, DownsampledReadings

# 区間ごとの集計 1 行: (区間の番号, 最小, 平均, 最大, 件数)
BucketRow = tuple[int, float, float, float, int]

_SECONDS_PER_DAY = 86_400
_MICROS = 1_000_000
# 0001-01-01 は date.fromordinal の 1。1970-01-01 は 719163
_ORDINAL_OF_EPOCH = 719_163


class BucketSeries(NamedTuple):
    """1 センサーの間引き結果。区間 i の開始は start_epoch + i * bucket_seconds（秒）。"""

    bucket_seconds: float
    start_epoch: float
    rows: list[BucketRow]

    def to_model(self) -> DownsampledReadings:
        """API のスキーマ（Pydantic）の形にする。JSON の基準（series_json が同じ文字列になる）。"""
        return DownsampledReadings(
            bucket_seconds=self.bucket_seconds,
            buckets=[
                DownsampledBucket(
                    start=datetime.fromtimestamp(
                        self.start_epoch + index * self.bucket_seconds, tz=UTC
                    ),
                    min=minimum,
                    avg=avg,
                    max=maximum,
                    count=count,
                )
                for index, minimum, avg, maximum, count in self.rows
            ],
        )


def _float_json(value: float) -> str:
    """Pydantic と同じ表記の float（指数表記・nan・inf のような特殊な値だけ Pydantic に任せる）。"""
    return to_json(value, inf_nan_mode="null").decode()


def _bucket_json(start: str, minimum: float, avg: float, maximum: float, count: int) -> str:
    """区間 1 つの JSON。"""
    low, mean, high = repr(minimum), repr(avg), repr(maximum)
    # repr の通常の表記（123.5 など）は Pydantic の出力と同じ。指数（1e-05）・nan・inf のときだけ
    # 'e'・'n' が入るので、3 つをつなげて 1 回調べる（1 つずつ調べると遅い）
    joined = low + mean + high
    if "e" in joined or "n" in joined:
        low, mean, high = _float_json(minimum), _float_json(avg), _float_json(maximum)
    return f'{{"start":"{start}","min":{low},"avg":{mean},"max":{high},"count":{count}}}'


def _iso_utc(epoch: float, date_texts: dict[int, str]) -> str:
    """epoch 秒を、Pydantic の datetime と同じ表記（2026-11-14T00:00:00Z）の文字列にする。

    datetime.fromtimestamp(epoch, tz=UTC) と同じく、マイクロ秒は四捨五入（偶数丸め）で決める。
    日付の文字列は 1 日に 1 回だけ作り、date_texts に入れて使い回す。
    """
    fraction, whole_float = math.modf(epoch)
    whole = int(whole_float)
    micros = round(fraction * _MICROS)
    if micros >= _MICROS:
        whole += 1
        micros -= _MICROS
    elif micros < 0:
        whole -= 1
        micros += _MICROS
    day, second_of_day = divmod(whole, _SECONDS_PER_DAY)
    date_text = date_texts.get(day)
    if date_text is None:
        date_text = date_texts[day] = date.fromordinal(_ORDINAL_OF_EPOCH + day).isoformat()
    hour, rest = divmod(second_of_day, 3600)
    minute, second = divmod(rest, 60)
    clock = f"{hour:02d}:{minute:02d}:{second:02d}"
    if micros == 0:
        return f"{date_text}T{clock}Z"
    return f"{date_text}T{clock}.{micros:06d}Z"


@lru_cache(maxsize=16)
def _start_texts(start_epoch: float, width: float) -> dict[int, str]:
    """区間の番号 → 開始時刻の文字列。範囲と区間数が同じなら、センサーが違っても開始時刻は同じ。

    まとめ取得は同じ範囲で 12 センサーほどを読むので、1 回作った文字列を使い回す
    （空の辞書を返し、使われた番号だけ、series_json が足していく）。
    """
    return {}


def series_json(series: BucketSeries) -> str:
    """BucketSeries を DownsampledReadings の JSON（camelCase）にする。"""
    start_epoch, width = series.start_epoch, series.bucket_seconds
    start_texts = _start_texts(start_epoch, width)
    date_texts: dict[int, str] = {}
    parts: list[str] = []
    for index, minimum, avg, maximum, count in series.rows:
        start = start_texts.get(index)
        if start is None:
            start = start_texts[index] = _iso_utc(start_epoch + index * width, date_texts)
        parts.append(_bucket_json(start, minimum, avg, maximum, count))
    buckets = ",".join(parts)
    return f'{{"bucketSeconds":{_float_json(width)},"buckets":[{buckets}]}}'


def batch_result_json(sensor_id: UUID, series: BucketSeries) -> str:
    """まとめ取得の 200 の 1 件（DownsampledBatchResult と同じ JSON。detail は null）。"""
    return f'{{"sensorId":"{sensor_id}","status":200,"data":{series_json(series)},"detail":null}}'
