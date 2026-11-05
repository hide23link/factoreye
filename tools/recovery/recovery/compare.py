"""バックアップと今の DB の比べ方（DB に触らない純粋な関数）。

【誰が使うか】app.py が読み込む。
"""

from __future__ import annotations

from dataclasses import dataclass

from recovery.dbinfo import DbSummary, WorkspaceRow


@dataclass(frozen=True)
class TableDiff:
    table: str
    backup: int | None
    current: int | None

    @property
    def diff(self) -> int | None:
        if self.backup is None or self.current is None:
            return None
        return self.current - self.backup


@dataclass(frozen=True)
class WorkspaceDiff:
    id: str
    name: str
    owner_email: str | None
    # "backup_only"（今の DB で失われた）/ "current_only"（バックアップの後に増えた）/ "both"
    status: str
    backup_sensors: int | None
    current_sensors: int | None
    backup_readings: int | None
    current_readings: int | None


def compare_tables(backup: DbSummary, current: DbSummary) -> list[TableDiff]:
    names = sorted(set(backup.table_counts) | set(current.table_counts))
    return [
        TableDiff(n, backup.table_counts.get(n), current.table_counts.get(n)) for n in names
    ]


def compare_workspaces(
    backup: list[WorkspaceRow], current: list[WorkspaceRow]
) -> list[WorkspaceDiff]:
    """ID で突き合わせる。失われたもの（backup_only）を先に並べる（復旧で一番見たいもの）。"""
    b = {w.id: w for w in backup}
    c = {w.id: w for w in current}
    result = []
    for ws_id in list(b) + [i for i in c if i not in b]:
        bw, cw = b.get(ws_id), c.get(ws_id)
        base = bw or cw
        assert base is not None
        status = "both" if bw and cw else ("backup_only" if bw else "current_only")
        result.append(
            WorkspaceDiff(
                ws_id, base.name, base.owner_email, status,
                bw.sensors if bw else None, cw.sensors if cw else None,
                bw.readings if bw else None, cw.readings if cw else None,
            )
        )
    order = {"backup_only": 0, "both": 1, "current_only": 2}
    return sorted(result, key=lambda d: order[d.status])
