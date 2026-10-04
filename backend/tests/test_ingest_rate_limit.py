"""取り込みのレート制限の解除モード（INGEST_RATE_LIMIT=off）のテスト。"""
import pytest
from fastapi import Request

from app.api import ingest
from app.config import settings


async def _handler(request: Request) -> str:
    return "ok"


@pytest.fixture
def restore_limit() -> object:
    original = settings.ingest_rate_limit
    yield
    settings.ingest_rate_limit = original


def test_off_mode_does_not_wrap_the_handler(restore_limit: object) -> None:
    settings.ingest_rate_limit = "off"
    assert ingest._ingest_rate_limit(_handler) is _handler


@pytest.mark.parametrize("value", ["OFF", " Off "])
def test_off_is_case_and_space_insensitive(restore_limit: object, value: str) -> None:
    settings.ingest_rate_limit = value
    assert ingest._ingest_rate_limit(_handler) is _handler


def test_limit_mode_wraps_the_handler(restore_limit: object) -> None:
    settings.ingest_rate_limit = "100/minute"
    wrapped = ingest._ingest_rate_limit(_handler)
    assert wrapped is not _handler
