"""取り込みのレート制限を、管理画面から期限付きで解除する仕組み。

- 状態はメモリに持つ（DB には保存しない）。再起動すると制限あり（既定）に戻る
- 解除は期限付き。期限を過ぎると自動で制限が戻る（解除したまま忘れないため）
- 単一インスタンス前提（レート制限のカウントと同じ前提）
- INGEST_RATE_LIMIT=off（環境変数）は、この仕組みより優先される

【誰が使うか】
- enable / disable: api/admin.py が、管理者が「制限を外す／戻す」を押したときに呼ぶ
- is_limit_off: api/ingest.py が、リクエストのたびに呼ぶ（今、制限を外してよいか）
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

# 1 回の解除で許す最長時間。長く解除したいときは、解除し直す
MAX_BYPASS_MINUTES = 240


@dataclass(frozen=True)
class BypassState:
    until: datetime | None
    set_by: str | None
    set_at: datetime | None


_state = BypassState(until=None, set_by=None, set_at=None)


def current(now: datetime | None = None) -> BypassState:
    """現在の状態を返す。期限を過ぎていれば、解除は終わったものとして扱う。"""
    now = now or datetime.now(UTC)
    if _state.until is not None and _state.until <= now:
        return BypassState(until=None, set_by=None, set_at=None)
    return _state


def is_limit_off(now: datetime | None = None) -> bool:
    """今、取り込みの制限を外してよいか。"""
    return current(now).until is not None


def enable(admin_id: str, minutes: int, now: datetime | None = None) -> BypassState:
    """指定した分数だけ解除する。0 以下や上限超えは拒否する（呼び出し側で検証する前提）。"""
    global _state
    now = now or datetime.now(UTC)
    _state = BypassState(
        until=now + timedelta(minutes=minutes),
        set_by=admin_id,
        set_at=now,
    )
    return _state


def disable() -> BypassState:
    """解除を止めて、制限を元に戻す。"""
    global _state
    _state = BypassState(until=None, set_by=None, set_at=None)
    return _state


def reset_for_tests() -> None:
    """テスト用。状態を初期値に戻す。"""
    disable()
