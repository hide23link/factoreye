"""FactorEyeClientの単体テスト。

標準ライブラリのみで完結させるため、実際のネットワークを使わず
http.server によるローカルのモックサーバーでingest APIの振る舞いを再現する。
pytestが無い環境でも `python3 -m unittest` で実行できる。
"""
from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from factoreye_client import FactorEyeClient  # noqa: E402


class _FakeClock:
    """time.monotonic の差し替え用。実時間を待たずにバックオフ経過をテストするため。"""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class _MockIngestServer:
    """POST /api/ingest/readings 相当のモック。固定のステータスコードを返す。"""

    def __init__(self) -> None:
        self.requests: list[dict[str, object]] = []
        self.next_status = 202
        self.next_headers: dict[str, str] = {}
        self.server = HTTPServer(("127.0.0.1", 0), self._make_handler())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def _make_handler(self) -> type[BaseHTTPRequestHandler]:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length) if length else b"{}"
                outer.requests.append(
                    {
                        "path": self.path,
                        # ヘッダー名は大文字小文字を問わずマッチさせる（Message.getは大小区別なし）
                        "api_key": self.headers.get("X-API-Key"),
                        "body": json.loads(raw),
                    }
                )
                self.send_response(outer.next_status)
                for name, header_value in outer.next_headers.items():
                    self.send_header(name, header_value)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                pass  # テスト出力を静かにする

        return Handler

    def shutdown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=2)


class FactorEyeClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.mock = _MockIngestServer()
        self.client = FactorEyeClient(self.mock.url, "test-api-key", timeout=2.0)
        self.clock = _FakeClock()
        self.client._clock = self.clock  # type: ignore[assignment]

    def tearDown(self) -> None:
        self.mock.shutdown()

    def test_send_success_posts_expected_body_and_header(self) -> None:
        ok = self.client.send("sensor-1", 42.0)

        self.assertTrue(ok)
        self.assertEqual(self.client.pending_count, 0)
        self.assertEqual(len(self.mock.requests), 1)
        req = self.mock.requests[0]
        self.assertEqual(req["path"], "/api/ingest/readings")
        self.assertEqual(req["api_key"], "test-api-key")
        self.assertEqual(req["body"], {"ingestKey": "sensor-1", "value": 42.0})

    def test_send_failure_buffers_instead_of_raising(self) -> None:
        self.mock.next_status = 500

        ok = self.client.send("sensor-1", 1.0)

        self.assertFalse(ok)
        self.assertEqual(self.client.pending_count, 1)

    def test_backoff_defers_without_hitting_server(self) -> None:
        self.mock.next_status = 500
        self.client.send("sensor-1", 1.0)
        requests_after_failure = len(self.mock.requests)

        # バックオフ期間中（初回は約1秒）はサーバーに触らずバッファに積むだけのはず
        ok = self.client.send("sensor-1", 2.0)

        self.assertFalse(ok)
        self.assertEqual(len(self.mock.requests), requests_after_failure)
        self.assertEqual(self.client.pending_count, 2)

    def test_buffered_readings_flush_as_one_batch_on_next_success(self) -> None:
        self.mock.next_status = 500
        self.client.send("sensor-1", 1.0)
        self.assertEqual(self.client.pending_count, 1)

        self.clock.advance(2.0)  # 初回バックオフ（約1秒+ジッター）を実時間を待たず経過させる

        self.mock.next_status = 202
        ok = self.client.send("sensor-1", 2.0)

        self.assertTrue(ok)
        self.assertEqual(self.client.pending_count, 0)
        last_request = self.mock.requests[-1]
        self.assertEqual(
            last_request["body"],
            {"ingestKey": "sensor-1", "readings": [{"value": 1.0}, {"value": 2.0}]},
        )

    def test_different_ingest_keys_do_not_mix_buffers(self) -> None:
        self.mock.next_status = 500
        self.client.send("sensor-1", 1.0)
        self.client.send("sensor-2", 9.0)
        self.assertEqual(self.client.pending_count, 2)

        self.clock.advance(2.0)
        self.mock.next_status = 202
        self.client.send("sensor-1", 2.0)

        # sensor-1分だけ流れ、sensor-2分は引き続きバッファに残る
        self.assertEqual(self.client.pending_count, 1)
        last_request = self.mock.requests[-1]
        self.assertEqual(
            last_request["body"],
            {"ingestKey": "sensor-1", "readings": [{"value": 1.0}, {"value": 2.0}]},
        )

    # --- 再送する失敗と、しない失敗（docs/architecture.md §9） ---

    def test_400_and_422_are_dropped_not_retried(self) -> None:
        for status in (400, 422):
            with self.subTest(status=status):
                self.mock.next_status = status
                ok = self.client.send(f"s{status}", 1.0)
                self.assertFalse(ok)
                self.assertEqual(self.client.pending_count, 0)
                # バックオフもかからず、次の値をすぐ送れる
                self.mock.next_status = 202
                self.assertTrue(self.client.send(f"s{status}", 2.0))
                self.assertEqual(
                    self.mock.requests[-1]["body"], {"ingestKey": f"s{status}", "value": 2.0}
                )

    def test_rejected_batch_does_not_poison_later_sends(self) -> None:
        self.mock.next_status = 500
        self.client.send("s", 1.0)
        self.clock.advance(2.0)
        self.mock.next_status = 400
        self.client.send("s", 2.0)  # 溜まっていた分ごと捨てられる
        self.assertEqual(self.client.pending_count, 0)
        self.mock.next_status = 202
        self.assertTrue(self.client.send("s", 3.0))
        self.assertEqual(self.mock.requests[-1]["body"], {"ingestKey": "s", "value": 3.0})

    def test_non_finite_values_are_never_sent_or_buffered(self) -> None:
        for bad in (float("nan"), float("inf"), float("-inf")):
            self.assertFalse(self.client.send("s", bad))
        self.assertEqual(self.mock.requests, [])
        self.assertEqual(self.client.pending_count, 0)
        self.assertTrue(self.client.send("s", 1.0))

    def test_non_numeric_values_are_dropped_without_raising(self) -> None:
        for bad in ("1.0", None, True, 10**400):
            with self.subTest(bad=bad):
                self.assertFalse(self.client.send("s", bad))  # type: ignore[arg-type]
        self.assertEqual(self.mock.requests, [])
        self.assertEqual(self.client.pending_count, 0)

    def test_retry_after_is_ignored_for_non_429(self) -> None:
        self.mock.next_status = 503
        self.mock.next_headers = {"Retry-After": "120"}
        self.client.send("s", 1.0)
        self.clock.advance(2.0)
        self.mock.next_status = 202
        self.assertTrue(self.client.send("s", 2.0))

    def test_misconfigured_sensor_does_not_disturb_other_sensors(self) -> None:
        # A だけ 404、B は 202 を返すよう、リクエスト本文で切り替える
        orig = self.mock.server.RequestHandlerClass.do_POST

        def routed(handler: BaseHTTPRequestHandler) -> None:
            length = int(handler.headers.get("Content-Length", 0))
            body = json.loads(handler.rfile.read(length))
            self.mock.requests.append({"body": body})
            handler.send_response(404 if body["ingestKey"] == "A" else 202)
            handler.end_headers()

        self.mock.server.RequestHandlerClass.do_POST = routed  # type: ignore[method-assign]
        try:
            for i in range(30):
                self.assertFalse(self.client.send("A", float(i)))
                self.assertTrue(self.client.send("B", float(i)), f"B が遅れた: {i}")
        finally:
            self.mock.server.RequestHandlerClass.do_POST = orig  # type: ignore[method-assign]
        b_sent = [
            r["body"] for r in self.mock.requests if r["body"]["ingestKey"] == "B"  # type: ignore[index]
        ]
        self.assertEqual(len(b_sent), 30)
        # A の保持は上限まで。古いものから捨てて、新しい 10 件が残る
        self.assertEqual(self.client.pending_count, 10)

    def test_5xx_and_408_are_retried(self) -> None:
        for status in (500, 503, 408):
            with self.subTest(status=status):
                client = FactorEyeClient(self.mock.url, "k", timeout=2.0)
                self.mock.next_status = status
                self.assertFalse(client.send("s", 1.0))
                self.assertEqual(client.pending_count, 1)

    def test_429_is_retried_and_retry_after_is_honored(self) -> None:
        self.mock.next_status = 429
        self.mock.next_headers = {"Retry-After": "60"}
        self.assertFalse(self.client.send("s", 1.0))
        self.assertEqual(self.client.pending_count, 1)
        self.clock.advance(30.0)  # 通常のバックオフ（約1秒）は過ぎたが、Retry-After は未経過
        before = len(self.mock.requests)
        self.assertFalse(self.client.send("s", 2.0))
        self.assertEqual(len(self.mock.requests), before)
        self.clock.advance(31.0)
        self.mock.next_status = 202
        self.mock.next_headers = {}
        self.assertTrue(self.client.send("s", 3.0))
        self.assertEqual(
            self.mock.requests[-1]["body"],
            {"ingestKey": "s", "readings": [{"value": 1.0}, {"value": 2.0}, {"value": 3.0}]},
        )

    def test_429_without_retry_after_uses_normal_backoff(self) -> None:
        self.mock.next_status = 429
        self.client.send("s", 1.0)
        self.clock.advance(2.0)
        self.mock.next_status = 202
        self.assertTrue(self.client.send("s", 2.0))

    def test_auth_and_unknown_key_errors_keep_the_data(self) -> None:
        for status in (401, 403, 404):
            with self.subTest(status=status):
                client = FactorEyeClient(self.mock.url, "k", timeout=2.0)
                self.mock.next_status = status
                self.assertFalse(client.send("s", 1.0))
                self.assertEqual(client.pending_count, 1)

    def test_connection_failure_is_retried(self) -> None:
        client = FactorEyeClient("http://127.0.0.1:1", "k", timeout=0.5)
        self.assertFalse(client.send("s", 1.0))
        self.assertEqual(client.pending_count, 1)


if __name__ == "__main__":
    unittest.main()
