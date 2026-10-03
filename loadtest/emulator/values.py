"""センサー値の生成。プロファイルごとに、時刻 t（秒）から値を決める。"""
import math
import random


def generate(
    profile: str,
    t: float,
    rng: random.Random,
    base: float,
    amplitude: float,
    spike_probability: float,
) -> float:
    if profile == "random":
        return rng.uniform(base - amplitude, base + amplitude)

    # sine / spiky: 周期 120 秒の緩やかな波 + 小さなノイズ
    wave = base + amplitude * math.sin(2 * math.pi * t / 120.0)
    value = wave + rng.gauss(0.0, amplitude * 0.02)
    if profile == "spiky" and rng.random() < spike_probability:
        # 閾値を越える値を混ぜ、アラーム経路も負荷に含める
        value = base + amplitude * 2.5
    return value
