"""計測。リクエスト名ごとに件数・エラー数・レイテンシ（p50/p95/p99）を集計する。"""
import time
from collections import deque
from dataclasses import dataclass, field

_SAMPLE_LIMIT = 5000  # レイテンシの保持件数（古いものから捨てる）
_RPS_WINDOW_S = 10.0


def percentile(sorted_values: list[float], p: float) -> float | None:
    if not sorted_values:
        return None
    index = min(len(sorted_values) - 1, round(p / 100 * (len(sorted_values) - 1)))
    return sorted_values[index]


@dataclass
class _Endpoint:
    count: int = 0
    errors: int = 0
    latencies: deque[float] = field(default_factory=lambda: deque(maxlen=_SAMPLE_LIMIT))


class Metrics:
    def __init__(self) -> None:
        self._endpoints: dict[str, _Endpoint] = {}
        self._timestamps: deque[float] = deque()
        self.started_at = time.monotonic()

    def record(self, name: str, status_code: int | None, latency_s: float) -> None:
        """status_code が None、または 4xx/5xx のものはエラーとして数える。
        ※ 429（レート制限）もエラーに含めるため、負荷の限界を見分けやすい。"""
        ep = self._endpoints.setdefault(name, _Endpoint())
        ep.count += 1
        if status_code is None or status_code >= 400:
            ep.errors += 1
        ep.latencies.append(latency_s * 1000)
        now = time.monotonic()
        self._timestamps.append(now)
        self._trim(now)

    def _trim(self, now: float) -> None:
        while self._timestamps and now - self._timestamps[0] > _RPS_WINDOW_S:
            self._timestamps.popleft()

    def reset(self) -> None:
        self._endpoints.clear()
        self._timestamps.clear()
        self.started_at = time.monotonic()

    def snapshot(self) -> dict[str, object]:
        now = time.monotonic()
        self._trim(now)
        endpoints: dict[str, object] = {}
        total = 0
        total_errors = 0
        for name, ep in sorted(self._endpoints.items()):
            total += ep.count
            total_errors += ep.errors
            ordered = sorted(ep.latencies)
            endpoints[name] = {
                "count": ep.count,
                "errors": ep.errors,
                "p50Ms": _round(percentile(ordered, 50)),
                "p95Ms": _round(percentile(ordered, 95)),
                "p99Ms": _round(percentile(ordered, 99)),
            }
        window = min(_RPS_WINDOW_S, max(now - self.started_at, 0.001))
        return {
            "total": total,
            "errors": total_errors,
            "errorRate": round(total_errors / total, 4) if total else 0.0,
            "rps": round(len(self._timestamps) / window, 2),
            "endpoints": endpoints,
        }


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 1)
