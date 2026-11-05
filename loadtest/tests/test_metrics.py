from emulator.metrics import Metrics, percentile


def test_percentile_basic() -> None:
    values = [float(x) for x in range(1, 101)]
    assert percentile(values, 50) == 51.0
    assert percentile(values, 95) == 95.0
    assert percentile([], 95) is None


def test_errors_include_4xx_5xx_and_transport_failures() -> None:
    m = Metrics()
    m.record("ingest", 202, 0.01)
    m.record("ingest", 429, 0.01)
    m.record("ingest", None, 0.01)
    m.record("ingest", 500, 0.01)
    snap = m.snapshot()
    ep = snap["endpoints"]["ingest"]  # type: ignore[index]
    assert ep["count"] == 4
    assert ep["errors"] == 3
    assert snap["errorRate"] == 0.75


def test_reset_clears_counts() -> None:
    m = Metrics()
    m.record("x", 200, 0.1)
    m.reset()
    assert m.snapshot()["total"] == 0
