"""FactorEyeClient: Raspberry PiなどLinux機からFactorEyeのセンサーIngest APIへ値を送る最小クライアント。

M5Stack向けArduinoライブラリ（clients/arduino-m5stack/）と同じ設計方針・同じ挙動:
  - 初期化 + send(ingest_key, value) のシンプルな呼び出し（Ambientライブラリと同じ使用感）
  - 指数バックオフ（1, 2, 4, 8, 16秒、上限30秒、±10%ジッター）
  - 送信失敗分はリングバッファ（最大100件）に一時保持し、次回成功時にまとめて再送

仕様の根拠: docs/factoreye-architecture.md §Sensor Data Ingest（デバイス側リトライ）。
依存ライブラリなし（標準ライブラリのみ）。Raspberry Pi OS標準のPython 3で追加インストール不要。

使い方:
    from factoreye_client import FactorEyeClient

    client = FactorEyeClient("http://192.168.1.50:8000", "your-ingest-api-key")
    client.send("rpi-temp-1", 25.3)
"""
from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass

_BACKOFF_CAP_SECONDS = 30.0
_BUFFER_CAPACITY = 100


@dataclass
class _BufferedReading:
    ingest_key: str
    value: float


class FactorEyeClient:
    """1つのFactorEyeバックエンド（self-hosted、共有APIキー）向けのクライアント。"""

    def __init__(self, host: str, api_key: str, timeout: float = 5.0) -> None:
        # host: 例 "http://192.168.1.50:8000"（末尾スラッシュは有無どちらでも可）
        # api_key: backend の .env に設定した INGEST_API_KEY と同じ値
        self._host = host.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._buffer: deque[_BufferedReading] = deque(maxlen=_BUFFER_CAPACITY)
        self._consecutive_failures = 0
        self._next_attempt_at = 0.0

    @property
    def pending_count(self) -> int:
        """現在リングバッファに溜まっている未送信件数（ログ表示等のデバッグ用）。"""
        return len(self._buffer)

    def send(self, ingest_key: str, value: float) -> bool:
        """ingest_key に対応するセンサーへ value を送信する。

        戻り値: 新しい値が（バッファ分も含め）実際に送信できた場合は True。
        バックオフ中・送信失敗の場合は False（内部でバッファに保持済み）。
        ブロッキングのリトライは行わない（呼び出し元のループを止めない）。
        """
        now = time.monotonic()
        if now < self._next_attempt_at:
            self._buffer.append(_BufferedReading(ingest_key, value))
            return False

        # 同じingest_keyで溜まっている分 + 今回の値 をまとめて1回のPOSTで送る
        values = [b.value for b in self._buffer if b.ingest_key == ingest_key]
        values.append(value)

        ok = self._post_readings(ingest_key, values)
        self._on_result(ok)

        if ok:
            self._buffer = deque(
                (b for b in self._buffer if b.ingest_key != ingest_key),
                maxlen=_BUFFER_CAPACITY,
            )
            return True

        self._buffer.append(_BufferedReading(ingest_key, value))
        return False

    def _post_readings(self, ingest_key: str, values: list[float]) -> bool:
        body: dict[str, object]
        if len(values) == 1:
            body = {"ingestKey": ingest_key, "value": values[0]}
        else:
            body = {"ingestKey": ingest_key, "readings": [{"value": v} for v in values]}

        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self._host}/api/ingest/readings",
            data=data,
            headers={"Content-Type": "application/json", "X-API-Key": self._api_key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                # backend は成功時 202 Accepted を返す（app/api/ingest.py 参照）
                return response.status == 202
        except (urllib.error.URLError, TimeoutError, OSError):
            return False

    def _on_result(self, success: bool) -> None:
        if success:
            self._consecutive_failures = 0
            self._next_attempt_at = 0.0
            return

        # 1, 2, 4, 8, 16, 30(上限)秒... docs/factoreye-architecture.md §デバイス側リトライ
        self._consecutive_failures = min(self._consecutive_failures + 1, 6)
        backoff = min(2.0 ** (self._consecutive_failures - 1), _BACKOFF_CAP_SECONDS)
        jitter = backoff * 0.1
        delay = backoff + random.uniform(-jitter, jitter)
        self._next_attempt_at = time.monotonic() + delay
