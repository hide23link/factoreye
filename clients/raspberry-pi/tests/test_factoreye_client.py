"""FactorEyeClientの単体テスト。

標準ライブラリのみで完結させるため、実際のネットワークを使わず
http.server によるローカルのモックサーバーでingest APIの振る舞いを再現する。
pytestが無い環境でも `python3 -m unittest` で実行できる。
"""
from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from factoreye_client import FactorEyeClient  # noqa: E402


class _MockIngestServer:
    """POST /api/ingest/readings 相当のモック。固定のステータスコードを返す。"""

    def __init__(self) -> None:
        self.requests: list[dict[str, object]] = []
        self.next_status = 202
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

        time.sleep(1.2)  # 初回バックオフ（約1秒+ジッター）が明けるまで待つ

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

        time.sleep(1.2)
        self.mock.next_status = 202
        self.client.send("sensor-1", 2.0)

        # sensor-1分だけ流れ、sensor-2分は引き続きバッファに残る
        self.assertEqual(self.client.pending_count, 1)
        last_request = self.mock.requests[-1]
        self.assertEqual(
            last_request["body"],
            {"ingestKey": "sensor-1", "readings": [{"value": 1.0}, {"value": 2.0}]},
        )


if __name__ == "__main__":
    unittest.main()
