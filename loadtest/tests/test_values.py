import random

from emulator.values import generate


def test_random_profile_stays_within_bounds() -> None:
    rng = random.Random(1)
    for _ in range(500):
        v = generate("random", 0, rng, base=50, amplitude=10, spike_probability=0)
        assert 40 <= v <= 60


def test_spiky_profile_produces_threshold_crossing_values() -> None:
    rng = random.Random(2)
    v = generate("spiky", 0, rng, base=50, amplitude=10, spike_probability=1.0)
    assert v == 50 + 10 * 2.5


def test_sine_profile_stays_close_to_the_wave() -> None:
    rng = random.Random(3)
    for t in range(0, 240, 7):
        v = generate("sine", float(t), rng, base=50, amplitude=10, spike_probability=0)
        assert 35 <= v <= 65
