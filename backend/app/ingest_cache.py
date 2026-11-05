"""取り込みの照合結果の、短時間のキャッシュ（機器のキーと、センサー）。

取り込みは、リクエストのたびに DB で「機器のキーの照合」と「センサーの検索」をしていた。
1 秒ごとに多数の機器から届くと、この 2 回の問い合わせ（と、センサーのオブジェクトの組み立て）で、
バックエンドの 1 プロセスの CPU が詰まる（100 台で飽和。docs/decisions.md 2026-10-30）。
そこで、成功した照合の結果を、数秒だけ覚えておく。

- 保持する秒数は INGEST_CACHE_SECONDS（既定 5）。0 にすると、キャッシュを使わない
- 覚えるのは、見つかったときの結果だけ（間違ったキー・未登録のセンサーは覚えない。
  作った直後に、古い「無い」が返らないように）
- 同じプロセスの中での変更（センサーの更新・削除、機器の作成・所属・失効）は、すぐに反映する
  （clear）。別のプロセス（--workers で複数）や、CLI からの変更は、最大で保持秒数だけ遅れる
  （例: 失効したキーが、最大 5 秒は通る。無効にしたセンサーが、最大 5 秒は受け付ける）
- 件数に上限がある。超えたら全部捨てる（メモリを使い切らないため）
"""
import time
from dataclasses import dataclass
from uuid import UUID

from app.config import settings

MAX_ENTRIES = 20_000


@dataclass(frozen=True)
class SensorInfo:
    """取り込みに必要なセンサーの情報（DB のオブジェクトは持たない）。"""

    id: UUID
    enabled: bool
    device_id: UUID | None


_devices: dict[str, tuple[UUID, float]] = {}      # キーのハッシュ → (機器の id, 期限)
_sensors: dict[str, tuple[SensorInfo, float]] = {}  # ingestKey → (情報, 期限)


def _ttl() -> float:
    return settings.ingest_cache_seconds


def get_device(key_hash: str) -> UUID | None:
    entry = _devices.get(key_hash)
    if entry is None:
        return None
    if entry[1] < time.monotonic():
        _devices.pop(key_hash, None)
        return None
    return entry[0]


def put_device(key_hash: str, device_id: UUID) -> None:
    if _ttl() <= 0:
        return
    if len(_devices) >= MAX_ENTRIES:
        _devices.clear()
    _devices[key_hash] = (device_id, time.monotonic() + _ttl())


def get_sensor(ingest_key: str) -> SensorInfo | None:
    entry = _sensors.get(ingest_key)
    if entry is None:
        return None
    if entry[1] < time.monotonic():
        _sensors.pop(ingest_key, None)
        return None
    return entry[0]


def put_sensor(ingest_key: str, info: SensorInfo) -> None:
    if _ttl() <= 0:
        return
    if len(_sensors) >= MAX_ENTRIES:
        _sensors.clear()
    _sensors[ingest_key] = (info, time.monotonic() + _ttl())


def clear() -> None:
    """全部捨てる。同じプロセスで、センサーや機器を変えたときに呼ぶ。"""
    _devices.clear()
    _sensors.clear()
