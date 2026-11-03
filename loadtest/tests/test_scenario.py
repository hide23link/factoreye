import pytest

from emulator.scenario import Scenario


def test_defaults_are_valid_and_match_the_expected_profile() -> None:
    sc = Scenario()
    sc.validate()
    assert sc.send_interval_s == 5.0
    assert 20 <= sc.users <= 50


@pytest.mark.parametrize("patch", [{"users": 0}, {"users": 101}, {"sensors_per_user": 11}])
def test_out_of_range_values_are_rejected(patch: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        Scenario().with_patch(patch)


def test_jitter_must_not_exceed_interval() -> None:
    with pytest.raises(ValueError):
        Scenario().with_patch({"send_interval_s": 1, "jitter_s": 2})


def test_production_host_is_rejected_unless_explicitly_allowed() -> None:
    prod = "https://factoreye.example.com"
    with pytest.raises(ValueError, match="本番ホスト"):
        Scenario(target_url=prod).validate()
    Scenario(target_url=prod, allow_production=True).validate()


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://192.168.0.10:8001",
        "http://10.1.2.3",
        "http://backend:8000",  # Docker のサービス名
        "http://raspberrypi.local",
        "http://oss.invalid",
    ],
)
def test_local_hosts_are_not_production(url: str) -> None:
    Scenario(target_url=url).validate()


@pytest.mark.parametrize("url", ["https://factory.example.com", "http://8.8.8.8", "https://iot.co.jp"])
def test_public_hosts_are_treated_as_production(url: str) -> None:
    with pytest.raises(ValueError, match="本番ホスト"):
        Scenario(target_url=url).validate()


def test_unknown_keys_are_rejected() -> None:
    with pytest.raises(ValueError, match="未知の項目"):
        Scenario().with_patch({"no_such_option": 1})


def test_string_values_from_the_form_are_coerced() -> None:
    sc = Scenario().with_patch({"users": "35", "send_interval_s": "5", "allow_production": "false"})
    assert sc.users == 35
    assert isinstance(sc.send_interval_s, float)
    assert sc.allow_production is False


def test_invalid_profile_is_rejected() -> None:
    with pytest.raises(ValueError):
        Scenario().with_patch({"value_profile": "chaotic"})
