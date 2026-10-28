"""R2 の WAL-G のバックアップ（ベース ＋ WAL）から、最新の状態の DB を一時的に作る。

本番（Proxmox の LXC）が消えた、またはデータが不完全なときに、R2 に残っているものから
「本番に無い行」を取り出すための入力にする（足す処理は merge.py。ここは DB を用意するだけ）。

流れ（長い処理なので、ジョブとして裏で進め、画面は状態を見る）:
  fetching  : wal-g backup-fetch LATEST で、最新のベースを作業用の場所（専用の PGDATA）に展開する
  replaying : recovery.signal と restore_command（wal-g wal-fetch）を置き、一時的な PostgreSQL を
              起動して WAL を最新まで再生する（TCP は開かず unix ソケットだけ。archive_mode=off）。
              昇格まで待つ
  ready     : 昇格後の DB に、読み取りで接続できる。merge の入力にする
  failed    : 失敗（message に理由）
使い終わったら reset() で PostgreSQL を止めて、作業用の場所を消す。

**WAL-G は読み取りのコマンド（backup-list・backup-fetch・wal-fetch）だけを使う。**
書き込み・削除系のコマンドは呼ばない。鍵も読み取りの権限で足りる（R2 のバケットは変えない）。

【誰が使うか】main.py が組み立て、app.py の /api/r2restore が呼ぶ。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

import asyncpg

PG_PORT = 54329  # unix ソケットの名前に入るだけ（TCP は開かない）
PG_USER = "factoreye"  # 本番の管理者のロール
PG_DATABASE = "factoreye"
REPLAY_TIMEOUT_SECONDS = 7200
_TAIL = 1500

# restore_command に使う。「無い」(74) は正常（再生の終わり）。それ以外の失敗（R2 への接続断など）で
# 0 以外を返すと、PostgreSQL は「WAL が無い」と解釈して古い時点で昇格してしまう。127 を返すと
# PostgreSQL が異常終了するので、失敗に気づける（infra の復元と同じ）
_FETCH_SCRIPT = """#!/bin/sh
wal-g wal-fetch "$1" "$2"
r=$?
[ $r -eq 0 ] || [ $r -eq 74 ] || exit 127
exit $r
"""


class RestoreError(Exception):
    pass


@dataclass
class RestoreInfo:
    """画面に出す、R2 のバックアップの内容。"""

    base_name: str | None = None
    base_time: str | None = None
    # 再生した WAL の最後の時刻（再生中に観測した最後の値。取れなければ None）
    wal_last_time: str | None = None
    alembic: str | None = None
    latest_reading: str | None = None


def parse_env_file(text: str) -> dict[str, str]:
    """docker の env_file の形式（KEY=値。# は注釈。値に引用符を付けない）。"""
    env: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


class R2Restore:
    def __init__(self, walg_env: dict[str, str], work_dir: Path) -> None:
        self._env = walg_env
        self._work = work_dir
        self._sock: Path | None = None
        self.state = "idle"
        self.message: str | None = None
        self.info = RestoreInfo()
        self._task: asyncio.Task[None] | None = None

    # ── 外から見るもの ───────────────────────────────────────────────

    def status(self) -> dict[str, object]:
        return {"state": self.state, "message": self.message, "info": asdict(self.info)}

    @property
    def busy(self) -> bool:
        return self.state in ("fetching", "replaying")

    @property
    def dsn(self) -> str:
        assert self._sock is not None and self.state == "ready"
        return f"postgresql://{PG_USER}@/{PG_DATABASE}?host={self._sock}&port={PG_PORT}"

    def start(self) -> None:
        """裏で復元を始める（実行中なら何もしない）。前の作業用の場所は消してから始める。"""
        if self.busy:
            return
        self.state, self.message, self.info = "fetching", None, RestoreInfo()
        self._task = asyncio.create_task(self._run())

    async def reset(self) -> None:
        """PostgreSQL を止めて、作業用の場所を消す。"""
        if self._task and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        await self._stop_and_clean()
        self.state, self.message, self.info = "idle", None, RestoreInfo()

    # ── 中身 ──────────────────────────────────────────────────────────

    def _child_env(self) -> dict[str, str]:
        # WAL-G の設定と最小限の環境だけを渡す（recovery 自身の秘密は渡さない）
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8"}
        env.update(self._env)
        return env

    async def _exec(self, *cmd: str, check: bool = True) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._child_env(),
        )
        out, err = await proc.communicate()
        code = proc.returncode or 0
        if check and code != 0:
            tail = err.decode("utf-8", errors="replace")[-_TAIL:]
            raise RestoreError(f"{cmd[0]} {cmd[1] if len(cmd) > 1 else ''} が失敗しました: {tail}")
        return code, out.decode("utf-8", errors="replace"), err.decode("utf-8", errors="replace")

    async def _run(self) -> None:
        try:
            await self._stop_and_clean()
            self._work.mkdir(parents=True, exist_ok=True)
            pgdata = self._work / "pgdata"
            await self._fetch_base(pgdata)
            self.state = "replaying"
            await self._replay(pgdata)
            self.state = "ready"
        except asyncio.CancelledError:
            raise
        except Exception as e:  # 失敗は画面に出す（原因を message に）
            self.state, self.message = "failed", str(e) or type(e).__name__
            await self._stop_and_clean()

    async def _fetch_base(self, pgdata: Path) -> None:
        _, out, _ = await self._exec("wal-g", "backup-list", "--detail", "--json")
        try:
            backups = json.loads(out)
        except ValueError:
            raise RestoreError("wal-g backup-list の出力を読めませんでした") from None
        if not backups:
            raise RestoreError("R2 にバックアップがありません")
        latest = backups[-1]
        self.info.base_name = str(latest.get("backup_name") or latest.get("name") or "")
        self.info.base_time = str(latest.get("time") or latest.get("start_time") or "") or None
        await self._exec("wal-g", "backup-fetch", str(pgdata), "LATEST")

    async def _replay(self, pgdata: Path) -> None:
        os.chmod(pgdata, 0o700)
        script = self._work / "walg-fetch.sh"
        script.write_text(_FETCH_SCRIPT)
        script.chmod(0o755)
        (pgdata / "recovery.signal").touch()
        # 本番の設定（archive_command など）は、起動時の -c で上書きする。restore_command だけ足す
        with (pgdata / "postgresql.auto.conf").open("a") as f:
            f.write(f"\nrestore_command = '{script} %f %p'\n")
        # unix ソケットのパスは長さに上限があるため、短い一時ディレクトリに置く
        self._sock = Path(tempfile.mkdtemp(prefix="r2r-"))
        opts = (
            f"-c archive_mode=off -c archive_command=/bin/true -c listen_addresses='' "
            f"-c unix_socket_directories={self._sock} -c port={PG_PORT}"
        )
        await self._exec(
            "pg_ctl", "-D", str(pgdata), "-o", opts, "-W", "-l", str(self._work / "pg.log"), "start"
        )
        loop = asyncio.get_running_loop()
        # -W（待たない）で始めたので、postmaster.pid ができる（起動が始まる）まで待つ
        for _ in range(60):
            if (pgdata / "postmaster.pid").exists():
                break
            await asyncio.sleep(0.5)
        deadline = loop.time() + REPLAY_TIMEOUT_SECONDS
        while True:
            if loop.time() > deadline:
                raise RestoreError(f"WAL の再生が {REPLAY_TIMEOUT_SECONDS} 秒以内に終わりません")
            code, _, _ = await self._exec("pg_ctl", "-D", str(pgdata), "status", check=False)
            if code != 0:
                raise RestoreError(
                    "WAL の再生中に PostgreSQL が止まりました（WAL の取得の失敗など）: "
                    + self._log_tail()
                )
            try:
                conn = await asyncpg.connect(
                    f"postgresql://{PG_USER}@/{PG_DATABASE}?host={self._sock}&port={PG_PORT}",
                    timeout=5,
                )
            except (OSError, asyncpg.PostgresError):
                await asyncio.sleep(1)  # まだ接続できる状態ではない（整合点に達していない）
                continue
            try:
                if await conn.fetchval("SELECT pg_is_in_recovery()"):
                    ts = await conn.fetchval("SELECT pg_last_xact_replay_timestamp()")
                    if ts is not None:
                        self.info.wal_last_time = ts.isoformat()
                else:
                    await self._read_info(conn)
                    return
            finally:
                await conn.close()
            await asyncio.sleep(1)

    async def _read_info(self, conn: asyncpg.Connection) -> None:
        with contextlib.suppress(asyncpg.PostgresError):
            self.info.alembic = await conn.fetchval("SELECT version_num FROM alembic_version")
        with contextlib.suppress(asyncpg.PostgresError):
            ts = await conn.fetchval("SELECT max(recorded_at) FROM readings")
            self.info.latest_reading = ts.isoformat() if ts else None

    def _log_tail(self) -> str:
        with contextlib.suppress(OSError):
            return (self._work / "pg.log").read_text(errors="replace")[-_TAIL:]
        return ""

    async def _stop_and_clean(self) -> None:
        pgdata = self._work / "pgdata"
        if (pgdata / "postmaster.pid").exists():
            await self._exec("pg_ctl", "-D", str(pgdata), "-m", "fast", "-w", "stop", check=False)
        shutil.rmtree(self._work, ignore_errors=True)
        if self._sock is not None:
            shutil.rmtree(self._sock, ignore_errors=True)
            self._sock = None
