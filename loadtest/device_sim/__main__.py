"""機器シミュレータの本体: 環境変数で設定して、1 か所分を送り続ける（`python -m device_sim`）。

環境変数:
  URL            取り込みの URL（例 http://192.0.2.10:8001/api/ingest/readings）【必須】
  SITE           か所の名前（例 ld01）。ingestKey は <SITE>-v / <SITE>-i / <SITE>-e【必須】
  INDEX          1 から始まる番号。基準値と、送信のずれを決める【必須】
  TOTAL          全体の台数（送信のずれの計算に使う。既定 1）
  MODE           second = 1 秒ごとに 1 回送る / batch = BATCH_SECONDS 個ためて送る（既定 batch）
  BATCH_SECONDS  batch でためる秒数（既定 60）
  DURATION       続ける秒数（既定 3600）
  KEY_FILE       機器のキーのファイル（既定 /key）。キーは画面にもログにも出さない
  LOG_FILE       ログのファイル（任意）

失敗したときは、その秒のデータを手元に溜め、次の送信でまとめて再送する（時刻つきなので二重にならない）。
溜めすぎ（600 個を超えた）ときは、古いものから捨てる。
"""
import contextlib
import http.client
import json
import os
import random
import statistics
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit

from .model import SensorModel, percentile, sample, send_offset_seconds

MAX_PENDING = 600


@dataclass
class Config:
    url: str
    site: str
    index: int
    key: str
    total: int = 1
    mode: str = "batch"
    batch_seconds: int = 60
    duration: int = 3600
    start_delay: int = 2          # 開始までの余裕（秒）。テストでは 0 にする
    log_file: str | None = None


@dataclass
class Result:
    sends: int
    ok: int
    errors: dict[int, int]
    pending: int
    dropped: int
    latencies_ms: list[float]


class Sender:
    """取り込みへ POST する。接続を使い回し、切れたら次の送信で張り直す。"""

    def __init__(self, url: str, key: str, timeout: float = 10) -> None:
        self.parts = urlsplit(url)
        self.key = key
        self.timeout = timeout
        self.conn: http.client.HTTPConnection | None = None

    def post(self, samples: list[dict]) -> tuple[int, float]:
        """(HTTP の状態, 所要ミリ秒)。通信の失敗は状態 0。"""
        body = json.dumps({"samples": samples}).encode()
        started = time.perf_counter()
        try:
            if self.conn is None:
                self.conn = http.client.HTTPConnection(
                    self.parts.hostname, self.parts.port, timeout=self.timeout
                )
            self.conn.request(
                "POST",
                self.parts.path,
                body=body,
                headers={"Content-Type": "application/json", "X-Device-Key": self.key},
            )
            response = self.conn.getresponse()
            response.read()
            return response.status, (time.perf_counter() - started) * 1000
        except OSError:
            if self.conn is not None:
                self.conn.close()
            self.conn = None
            return 0, (time.perf_counter() - started) * 1000


def run(config: Config, log=print) -> Result:
    rng = random.Random(config.index * 7919 + int(time.time()))
    model = SensorModel(config.index, config.site, rng)
    sender = Sender(config.url, config.key)
    if config.mode == "second":
        # 1 秒ごとの送信: 全台が同じ瞬間に送らないよう、0〜1 秒の範囲でずらす
        offset = rng.uniform(0, 1)
        every = 1
    else:
        # まとめ送り: 送る瞬間を、batch_seconds の中で均等にずらす
        offset = float(send_offset_seconds(config.index, config.total, config.batch_seconds))
        every = config.batch_seconds
    start = int(time.time()) + config.start_delay + (0 if config.mode == "second" else int(offset))
    phase = offset if config.mode == "second" else 0.0
    log(f"{config.site} 開始: {config.mode}、{config.duration} 秒、{config.url}、ずれ {offset:.2f} 秒")

    pending: list[dict] = []
    ok = dropped = sends = 0
    errors: dict[int, int] = {}
    all_ms: list[float] = []
    window: list[float] = []
    for n in range(config.duration):
        delay = start + n + phase - time.time()
        if delay > 0:
            time.sleep(delay)
        pending.append(sample(start + n, model.read()))
        if len(pending) > MAX_PENDING:
            dropped += len(pending) - MAX_PENDING
            pending = pending[-MAX_PENDING:]
        if (n + 1) % every == 0 or n + 1 == config.duration:
            count, first, last = len(pending), pending[0]["timestamp"], pending[-1]["timestamp"]
            status, ms = sender.post(pending)
            sends += 1
            all_ms.append(ms)
            window.append(ms)
            if status == 202:
                ok += 1
                pending = []
            else:
                errors[status] = errors.get(status, 0) + 1
            if config.mode == "batch" or sends % 60 == 0:
                log(
                    f"{config.site} 送信 {sends}: {first} 〜 {last}（{count} 時刻 × 3 要素）"
                    f"→ {status} {ms:.0f} ms | 成功 {ok} 失敗 {dict(errors) or 0} "
                    f"溜め {len(pending)} 捨て {dropped}"
                    + (
                        ""
                        if config.mode == "batch"
                        else f" | 直近 {len(window)} 回: 平均 {statistics.mean(window):.0f} ms "
                        f"p95 {percentile(sorted(window), 0.95):.0f} ms 最大 {max(window):.0f} ms"
                    )
                )
                window = []
    if all_ms:
        ordered = sorted(all_ms)
        log(
            f"{config.site} DONE 成功 {ok}/{sends} 失敗 {dict(errors) or 0} 未送信 {len(pending)} "
            f"捨て {dropped} | 平均 {statistics.mean(all_ms):.0f} ms "
            f"p95 {percentile(ordered, 0.95):.0f} ms 最大 {ordered[-1]:.0f} ms"
        )
    return Result(sends, ok, errors, len(pending), dropped, all_ms)


def config_from_env() -> Config:
    env = os.environ
    missing = [k for k in ("URL", "SITE", "INDEX") if not env.get(k)]
    if missing:
        sys.exit(f"環境変数が足りません: {', '.join(missing)}")
    with open(env.get("KEY_FILE", "/key"), encoding="utf-8") as f:
        key = f.read().strip()
    mode = env.get("MODE", "batch")
    if mode not in ("second", "batch"):
        sys.exit("MODE は second か batch にしてください")
    return Config(
        url=env["URL"],
        site=env["SITE"],
        index=int(env["INDEX"]),
        key=key,
        total=int(env.get("TOTAL", "1")),
        mode=mode,
        batch_seconds=int(env.get("BATCH_SECONDS", "60")),
        duration=int(env.get("DURATION", "3600")),
        log_file=env.get("LOG_FILE"),
    )


def main() -> int:
    config = config_from_env()
    with contextlib.ExitStack() as stack:
        log_file = (
            stack.enter_context(open(config.log_file, "a", buffering=1, encoding="utf-8"))
            if config.log_file
            else None
        )

        def log(message: str) -> None:
            line = f"[{datetime.now(UTC).strftime('%H:%M:%S')}] {message}"
            print(line, flush=True)
            if log_file:
                log_file.write(line + "\n")

        run(config, log)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
