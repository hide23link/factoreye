"""書き戻しの直前に、今の DB を丸ごと控える（書き戻しを取り消したくなったときのため）。

【誰が使うか】app.py が読み込む。
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import os
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

from recovery.scratch import dsn_with_user

SNAPSHOT_PREFIX = "before-merge-"


class SnapshotError(Exception):
    pass


async def dump_database(dsn: str, dest_dir: Path) -> Path:
    """pg_dump で取り、復旧ツールのバックアップ一覧に出る形（.sql.gz と .sha256）で置く。"""
    parts = urlsplit(dsn)
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = f"{SNAPSHOT_PREFIX}{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}.sql.gz"
    dest = dest_dir / name
    partial = dest_dir / f".partial-{name}"
    # パスワードはコマンドの引数に載せない（ps で見えるため）
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "PGPASSWORD": unquote(parts.password or ""),
    }
    proc = await asyncio.create_subprocess_exec(
        "pg_dump", "--no-password", "-d", dsn_with_user(dsn, unquote(parts.username or "")),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    assert proc.stdout is not None and proc.stderr is not None
    stderr_task = asyncio.create_task(proc.stderr.read())
    digest = hashlib.sha256()
    try:
        with partial.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb") as gz:
            while chunk := await proc.stdout.read(1024 * 1024):
                await asyncio.to_thread(gz.write, chunk)
        code = await proc.wait()
        stderr = await stderr_task
        if code != 0:
            raise SnapshotError(
                f"今の DB の控えを取れませんでした（pg_dump 終了コード {code}）: "
                + stderr.decode("utf-8", errors="replace")[-1000:]
            )
        # 書き終えたファイルを少しずつ読んで計算する（大きな DB でもメモリに載せない）
        with partial.open("rb") as f:
            while chunk := f.read(1024 * 1024):
                digest.update(chunk)
        partial.rename(dest)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    dest.with_name(dest.name + ".sha256").write_text(f"{digest.hexdigest()}  {dest.name}\n")
    return dest
