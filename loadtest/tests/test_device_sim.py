"""機器シミュレータ（device_sim）のテスト。外部サービスは使わない（手元の簡易サーバーに送る）。"""
import json
import random
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import ClassVar

from device_sim.__main__ import Config, run
from device_sim.model import (
    DECIMALS,
    RANGE,
    SensorModel,
    base_values,
    iso_seconds,
    percentile,
    sample,
    send_offset_seconds,
)


def test_base_values_are_inside_the_ranges_for_up_to_100_sites() -> None:
    for index in range(1, 101):
        for k, value in base_values(index).items():
            low, high = RANGE[k]
            assert low <= value <= high, (index, k, value)


def test_values_stay_in_range_and_have_the_right_keys_and_decimals() -> None:
    for index in (1, 50, 100):
        model = SensorModel(index, f"ld{index:02d}", random.Random(index))
        for _ in range(3000):
            values = model.read()
            assert set(values) == {f"ld{index:02d}-v", f"ld{index:02d}-i", f"ld{index:02d}-e"}
            for key, value in values.items():
                k = key[-1]
                low, high = RANGE[k]
                assert low <= value <= high
                assert round(value, DECIMALS[k]) == value


def test_values_actually_fluctuate_but_stay_near_the_base() -> None:
    model = SensorModel(10, "ld10", random.Random(1))
    volts = [model.read()["ld10-v"] for _ in range(2000)]
    assert len(set(volts)) > 20                       # 乱数で上下している
    base = base_values(10)["v"]
    assert abs(sum(volts) / len(volts) - base) < 0.5  # 基準値の近くに戻る


def test_same_seed_gives_the_same_values() -> None:
    a = SensorModel(3, "ld03", random.Random(7))
    b = SensorModel(3, "ld03", random.Random(7))
    assert [a.read() for _ in range(5)] == [b.read() for _ in range(5)]


def test_send_offsets_spread_evenly_over_the_period() -> None:
    offsets = [send_offset_seconds(i, 100) for i in range(1, 101)]
    assert min(offsets) == 0 and max(offsets) == 59
    assert offsets == sorted(offsets)
    assert len(set(offsets)) == 60                    # 60 秒すべてに散らばる
    assert [send_offset_seconds(i, 10) for i in range(1, 11)] == [0, 6, 12, 18, 24, 30, 36, 42, 48, 54]
    assert send_offset_seconds(1, 1) == 0


def test_timestamps_are_whole_seconds_without_milliseconds() -> None:
    assert iso_seconds(1_730_000_000) == "2024-10-27T03:33:20Z"
    s = sample(1_730_000_000, {"ld01-v": 1.0})
    assert s == {"timestamp": "2024-10-27T03:33:20Z", "values": {"ld01-v": 1.0}}
    assert "." not in s["timestamp"]


def test_percentile() -> None:
    values = list(range(1, 101))
    assert percentile([float(v) for v in values], 0.95) == 96.0
    assert percentile([5.0], 0.99) == 5.0


class _Recorder(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict]] = []
    statuses: ClassVar[list[int]] = []

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).requests.append({"key": self.headers.get("X-Device-Key"), "body": body})
        status = type(self).statuses.pop(0) if type(self).statuses else 202
        self.send_response(status)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args: object) -> None:
        pass


def _serve(statuses: list[int] | None = None) -> tuple[HTTPServer, str]:
    _Recorder.requests = []
    _Recorder.statuses = list(statuses or [])
    server = HTTPServer(("127.0.0.1", 0), _Recorder)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}/api/ingest/readings"


def test_batch_mode_sends_the_collected_samples_with_the_device_key() -> None:
    server, url = _serve()
    try:
        config = Config(url=url, site="ld01", index=1, key="secret-key", mode="batch",
                        batch_seconds=2, duration=4, start_delay=0)
        result = run(config, log=lambda message: None)
    finally:
        server.shutdown()
    assert result.sends == 2 and result.ok == 2 and not result.errors
    assert [r["key"] for r in _Recorder.requests] == ["secret-key", "secret-key"]
    samples = [s for r in _Recorder.requests for s in r["body"]["samples"]]
    assert len(samples) == 4
    stamps = [s["timestamp"] for s in samples]
    assert stamps == sorted(stamps) and len(set(stamps)) == 4      # 1 秒ずつ、重ならない
    assert all(set(s["values"]) == {"ld01-v", "ld01-i", "ld01-e"} for s in samples)


def test_failed_sends_are_kept_and_resent_together() -> None:
    server, url = _serve([500])                        # 1 回目だけ失敗
    try:
        config = Config(url=url, site="ld02", index=2, key="k", mode="batch",
                        batch_seconds=2, duration=4, start_delay=0)
        result = run(config, log=lambda message: None)
    finally:
        server.shutdown()
    assert result.errors == {500: 1} and result.ok == 1
    assert result.pending == 0 and result.dropped == 0
    resent = _Recorder.requests[1]["body"]["samples"]
    assert len(resent) == 4                            # 失敗した 2 個 + 新しい 2 個を、まとめて再送
