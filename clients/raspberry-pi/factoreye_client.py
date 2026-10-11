"""FactorEyeClient: Raspberry PiなどLinux機からFactorEyeのセンサーIngest APIへ値を送る最小クライアント。

M5Stack向けArduinoライブラリ（clients/arduino-m5stack/）と同じ設計方針・同じ挙動:
  - 初期化 + send(ingest_key, value) のシンプルな呼び出し（Ambientライブラリと同じ使用感）
  - 指数バックオフ（1, 2, 4, 8, 16秒、上限30秒、±10%ジッター）
  - 送信失敗分はリングバッファ（最大100件）に一時保持し、次回成功時にまとめて再送

仕様の根拠: docs/architecture.md §9 デバイス連携。
依存ライブラリなし（標準ライブラリのみ）。Raspberry Pi OS標準のPython 3で追加インストール不要。

使い方:
    from factoreye_client import FactorEyeClient

    client = FactorEyeClient("http://192.168.1.50:8000", "your-ingest-api-key")
    client.send("rpi-temp-1", 25.3)
"""
from __future__ import annotations

import json
import logging
import math
import random
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass

_log = logging.getLogger("factoreye_client")

# 送信失敗が続いたときの待ち時間の上限（秒）。これより長くは待たない
_BACKOFF_CAP_SECONDS = 30.0
# 未送信の値を溜めておく最大件数。満杯になると、一番古いものから捨てる（deque の maxlen）
_BUFFER_CAPACITY = 100
# Retry-After（429 のとき）に従って待つ時間の上限（秒）。バックオフの上限より長く待つ場合があるため別に持つ
_RETRY_AFTER_CAP_SECONDS = 300.0

# 送信結果の分類（_post_readings の戻り値）
_OK = "ok"  # 202 Accepted
_RETRY = "retry"  # 通信エラー・タイムアウト・5xx・408・429: バッファに残して、バックオフ後に再送する
_HOLD = "hold"  # 401・403・404: 設定の誤り。データは捨てず、バックオフ後に再送し続ける（警告ログ）
_DROP = "drop"  # 400・422 などの 4xx: 同じ内容を送り直しても成功しない。その分を捨てる（警告ログ）


@dataclass
class _BufferedReading:
    """未送信の1件（どのセンサーの、どの値か）。"""

    ingest_key: str
    value: float


class FactorEyeClient:
    """1つのFactorEyeバックエンド（self-hosted、共有APIキー）向けのクライアント。

    状態（持っているもの）:
    - 未送信のリングバッファ（最大 100 件）
    - 連続の失敗回数と、次に送ってよい時刻（バックオフ用）
    送信は呼び出し元のスレッドで同期的に行うが、失敗しても待たない（ブロックしない）。
    """

    def __init__(self, host: str, api_key: str, timeout: float = 5.0) -> None:
        """接続先と、認証キーを設定する。送信はまだ行わない。

        host は例 "http://192.168.1.50:8000"、api_key は backend の .env の INGEST_API_KEY。
        timeout は1回の送信の待ち時間（秒）。
        """
        # host: 例 "http://192.168.1.50:8000"（末尾スラッシュは有無どちらでも可）
        # api_key: backend の .env に設定した INGEST_API_KEY と同じ値
        self._host = host.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._buffer: deque[_BufferedReading] = deque(maxlen=_BUFFER_CAPACITY)
        self._consecutive_failures = 0
        self._next_attempt_at = 0.0
        # テストで実時間の経過を待たずに済むよう差し替え可能にしている（非公開属性だが
        # tests/test_factoreye_client.py から直接差し替える想定）
        self._clock = time.monotonic

    @property
    def pending_count(self) -> int:
        """現在リングバッファに溜まっている未送信件数（ログ表示等のデバッグ用）。"""
        return len(self._buffer)

    def send(self, ingest_key: str, value: float) -> bool:
        """ingest_key に対応するセンサーへ value を送信する。

        流れ: バックオフ中なら、送らずにバッファへ入れる。そうでなければ、バッファに溜まった同じセンサーの値と
        今回の値をまとめて送る。成功したら、送った分をバッファから消す。失敗したら、今回の値をバッファに残す。


        戻り値: 新しい値が（バッファ分も含め）実際に送信できた場合は True。
        バックオフ中・送信失敗の場合は False（内部でバッファに保持済み）。
        ブロッキングのリトライは行わない（呼び出し元のループを止めない）。
        """
        if not math.isfinite(value):
            # NaN・Infinity は backend が 400 で拒否する値。バッファに入れると、同じセンサーの
            # 以降のバッチがすべて拒否されるため、送る前に捨てる
            _log.warning("%s: 有限でない値（%r）は送らずに捨てました", ingest_key, value)
            return False

        now = self._clock()
        if now < self._next_attempt_at:
            self._buffer.append(_BufferedReading(ingest_key, value))
            return False

        # 同じingest_keyで溜まっている分 + 今回の値 をまとめて1回のPOSTで送る
        values = [b.value for b in self._buffer if b.ingest_key == ingest_key]
        values.append(value)

        outcome, retry_after = self._post_readings(ingest_key, values)

        if outcome == _OK or outcome == _DROP:
            if outcome == _DROP:
                # 再送しても成功しない内容。溜まっていた分も同じバッチなので、まとめて捨てる
                _log.warning(
                    "%s: サーバーが %d 件を受け付けませんでした（再送しても成功しないため捨てます）",
                    ingest_key,
                    len(values),
                )
            # サーバーとは通信できているので、バックオフは解除する
            self._on_result(True)
            self._buffer = deque(
                (b for b in self._buffer if b.ingest_key != ingest_key),
                maxlen=_BUFFER_CAPACITY,
            )
            return outcome == _OK

        if outcome == _HOLD:
            _log.warning(
                "%s: 認証・登録の設定を確認してください（%d 件を保持して再送します）",
                ingest_key,
                len(values),
            )
        self._on_result(False, retry_after)
        self._buffer.append(_BufferedReading(ingest_key, value))
        return False

    def _post_readings(
        self, ingest_key: str, values: list[float]
    ) -> tuple[str, float | None]:
        """値を、取り込み API へ1回だけ POST する。例外は出さない。

        戻り値: (結果の分類, Retry-After の秒数 or None)。分類は _OK / _RETRY / _HOLD / _DROP。

        1件なら {"ingestKey", "value"}、複数件なら {"ingestKey", "readings"} の形で送る（backend の受け口の形式）。
        """
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
                return (_OK if response.status == 202 else _RETRY), None
        except urllib.error.HTTPError as exc:  # URLError の派生なので、先に判定する
            return _classify_http_error(exc.code), _parse_retry_after(exc.headers)
        except (urllib.error.URLError, TimeoutError, OSError):
            return _RETRY, None

    def _on_result(self, success: bool, retry_after: float | None = None) -> None:
        """送信の結果に応じて、次に送ってよい時刻（バックオフ）を決める。

        成功: 失敗の回数と待ち時間をリセットする。
        失敗: 待ち時間を 1, 2, 4, 8, 16, 30 秒と倍にしていき（上限 30 秒）、±10% のゆらぎを付ける。
        ゆらぎは、多くの機器が同時に再送して、サーバーに負荷が集中するのを防ぐため。
        サーバーが Retry-After（429 のとき）で待ち時間を指定していれば、それより早くは送らない。
        """
        if success:
            self._consecutive_failures = 0
            self._next_attempt_at = 0.0
            return

        # 1, 2, 4, 8, 16, 30(上限)秒... docs/architecture.md §9 デバイス連携
        self._consecutive_failures = min(self._consecutive_failures + 1, 6)
        backoff = min(2.0 ** (self._consecutive_failures - 1), _BACKOFF_CAP_SECONDS)
        jitter = backoff * 0.1
        delay = backoff + random.uniform(-jitter, jitter)
        if retry_after is not None:
            delay = max(delay, min(retry_after, _RETRY_AFTER_CAP_SECONDS))
        self._next_attempt_at = self._clock() + delay


def _classify_http_error(code: int) -> str:
    """HTTP のエラーコードを、再送の扱いに分類する。"""
    if code in (401, 403, 404):
        return _HOLD
    if code in (408, 429) or code >= 500:
        return _RETRY
    if 400 <= code < 500:
        return _DROP
    return _RETRY  # 3xx など想定外のもの。データは失わない側に倒す


def _parse_retry_after(headers: object) -> float | None:
    """Retry-After（秒数の形式）を読む。無い・読めない・日付形式なら None。"""
    getter = getattr(headers, "get", None)
    raw = getter("Retry-After") if getter else None
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        return None
    return seconds if math.isfinite(seconds) and seconds > 0 else None
