"""機器シミュレータの、値の生成・送信の位置・本文の組み立て（通信を含まない。単体テストできる部分）。"""
import random
from datetime import UTC, datetime

# 1 か所の 3 要素。キーの末尾（v / i / e）と、範囲・桁数
ELEMENTS = ("v", "i", "e")
RANGE = {"v": (0.0, 60.0), "i": (0.0, 50.0), "e": (-5.0, 5.0)}     # 電圧 V・電流 A・電位 V
DECIMALS = {"v": 2, "i": 2, "e": 3}
SD = {"v": 0.04, "i": 0.015, "e": 0.003}      # 1 秒ごとの揺れの大きさ
PULL = 0.15                                    # 基準値へ戻る強さ（平均回帰）
SPIKE_RATE = 0.01                              # まれに、大きめの揺れが入る割合
SPIKE_SCALE = 8


def base_values(index: int) -> dict[str, float]:
    """INDEX（1〜）ごとの基準値。か所ごとに少しずつ違う値にする（範囲内）。"""
    return {"v": 11.5 + 0.15 * index, "i": 0.40 + 0.05 * index, "e": -1.20 + 0.05 * index}


class SensorModel:
    """基準値に戻りながら、乱数で上下する 3 要素の値を作る。"""

    def __init__(self, index: int, site: str, rng: random.Random | None = None) -> None:
        self.site = site
        self.rng = rng or random.Random()
        self.base = base_values(index)
        self.state = dict(self.base)

    def read(self) -> dict[str, float]:
        """1 秒分の値を {ingestKey: 値} で返す。ingestKey は `<SITE>-v` `<SITE>-i` `<SITE>-e`。"""
        values: dict[str, float] = {}
        for k in ELEMENTS:
            self.state[k] += PULL * (self.base[k] - self.state[k]) + self.rng.gauss(0, SD[k])
            if self.rng.random() < SPIKE_RATE:
                self.state[k] += self.rng.gauss(0, SD[k] * SPIKE_SCALE)
            low, high = RANGE[k]
            self.state[k] = min(high, max(low, self.state[k]))
            values[f"{self.site}-{k}"] = round(self.state[k], DECIMALS[k])
        return values


def send_offset_seconds(index: int, total: int, period: int = 60) -> int:
    """送信の瞬間を、period 秒の中で均等にずらす（0〜period−1 秒）。多数の機器が同時に送らないため。"""
    return ((index - 1) * period) // max(1, total)


def iso_seconds(unix_seconds: int) -> str:
    """秒単位の時刻（ミリ秒なし）。例: 2026-10-30T12:00:00Z"""
    return datetime.fromtimestamp(unix_seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def sample(unix_seconds: int, values: dict[str, float]) -> dict:
    """`samples` の要素 1 つ（ある時刻の、複数センサーの値）。"""
    return {"timestamp": iso_seconds(unix_seconds), "values": values}


def percentile(sorted_values: list[float], q: float) -> float:
    return sorted_values[min(len(sorted_values) - 1, int(len(sorted_values) * q))]
