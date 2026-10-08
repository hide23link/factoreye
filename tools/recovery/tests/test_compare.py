from datetime import UTC, datetime

from recovery.compare import compare_tables, compare_workspaces
from recovery.dbinfo import DbSummary, WorkspaceRow

T = datetime(2026, 10, 8, tzinfo=UTC)


def _ws(ws_id: str, sensors: int, readings: int) -> WorkspaceRow:
    return WorkspaceRow(
        ws_id, f"ws-{ws_id}", f"{ws_id}@example.com", "free", T, sensors, readings, T
    )


def test_compare_tables_includes_tables_on_either_side() -> None:
    backup = DbSummary("15", "a", {"users": 3, "readings": 100}, T, [])
    current = DbSummary("15", "b", {"users": 1, "webhook_subscriptions": 2}, T, [])

    diffs = {d.table: d for d in compare_tables(backup, current)}

    assert diffs["users"].diff == -2
    assert diffs["readings"].current is None and diffs["readings"].diff is None
    assert diffs["webhook_subscriptions"].backup is None


def test_compare_workspaces_lists_lost_first() -> None:
    backup = [_ws("both", 2, 10), _ws("lost", 1, 5)]
    current = [_ws("new", 1, 1), _ws("both", 2, 12)]

    result = compare_workspaces(backup, current)

    assert [(w.id, w.status) for w in result] == [
        ("lost", "backup_only"), ("both", "both"), ("new", "current_only"),
    ]
    both = result[1]
    assert (both.backup_readings, both.current_readings) == (10, 12)
    assert result[0].current_sensors is None
