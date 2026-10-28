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
import re
import secrets
import shlex
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
# 鍵は PostgreSQL のプロセスの環境には置かず、権限 600 のファイルからこの包みが読む
_FETCH_SCRIPT = """#!/bin/sh
set -a
. "{secrets}"
set +a
wal-g wal-fetch "$1" "$2"
r=$?
[ $r -eq 0 ] || [ $r -eq 74 ] || exit 127
exit $r
"""

# 復元した PostgreSQL の設定は、バックアップの中身を使わず、最小の自前のものに置き換える
# （改ざんされたバックアップの shared_preload_libraries などで、コードを実行されないため）
_HBA = "local all all trust\n"
_CONF = """listen_addresses = ''
unix_socket_directories = '{sock}'
port = {port}
archive_mode = off
restore_command = '{script} %f %p'
hot_standby = on
shared_buffers = 128MB
shared_preload_libraries = ''
session_preload_libraries = ''
local_preload_libraries = ''
archive_library = ''
max_connections = {max_connections}
max_worker_processes = {max_worker_processes}
max_wal_senders = {max_wal_senders}
max_prepared_transactions = {max_prepared_transactions}
max_locks_per_transaction = {max_locks_per_transaction}
wal_level = {wal_level}
"""
# 復旧中の設定は、元のサーバー以上でなければ再生が止まる。pg_controldata から元の値を読む
_CONTROL_KEYS = {
    "max_connections setting": "max_connections",
    "max_worker_processes setting": "max_worker_processes",
    "max_wal_senders setting": "max_wal_senders",
    "max_prepared_xacts setting": "max_prepared_transactions",
    "max_locks_per_xact setting": "max_locks_per_transaction",
    "wal_level setting": "wal_level",
}
_CONTROL_DEFAULTS = {
    "max_connections": "100", "max_worker_processes": "8", "max_wal_senders": "10",
    "max_prepared_transactions": "0", "max_locks_per_transaction": "64", "wal_level": "replica",
}
_SECRET_NAME_PARTS = ("KEY", "SECRET", "TOKEN", "PASS")
_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# 作業用の領域の中で、消してよい場所（R2_RESTORE_DIR そのものは消さない）
WORK_SUBDIR = "work"
SOCKET_PREFIX = "r2r-"
_SAFETY_MARGIN_BYTES = 512 * 1024 * 1024


def free_bytes(path: Path) -> int:
    return shutil.disk_usage(path).free


class RestoreError(Exception):
    pass


async def _kill(proc: asyncio.subprocess.Process) -> None:
    with contextlib.suppress(ProcessLookupError):
        proc.kill()
    await proc.wait()


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
        key = key.strip()
        if _ENV_NAME_RE.fullmatch(key):  # シェルに書くので、名前の形が正しいものだけ読む
            env[key] = value.strip()
    return env


def _write_fresh(path: Path, text: str, mode: int = 0o644) -> None:
    """新しいファイルとして書く。バックアップに仕込まれたシンボリックリンクをたどらない。"""
    path.unlink(missing_ok=True)  # リンクなら、リンク先でなくリンクそのものを消す
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w") as f:
        f.write(text)


class R2Restore:
    def __init__(self, walg_env: dict[str, str], work_dir: Path) -> None:
        self._env = {k: v for k, v in walg_env.items() if _ENV_NAME_RE.fullmatch(k)}
        # 消してよいのは、この中の work だけ（設定された場所に、ほかのファイルがあっても消さない）
        self._work = work_dir / WORK_SUBDIR
        self._sock: Path | None = None
        self.state = "idle"
        self.message: str | None = None
        self.info = RestoreInfo()
        self._task: asyncio.Task[None] | None = None
        self._procs: set[asyncio.subprocess.Process] = set()
        self._reader: str | None = None

    # ── 外から見るもの ───────────────────────────────────────────────

    def status(self) -> dict[str, object]:
        message = self.redact(self.message) if self.message else None
        return {"state": self.state, "message": message, "info": asdict(self.info)}

    @property
    def busy(self) -> bool:
        return self.state in ("fetching", "replaying")

    @property
    def dsn(self) -> str:
        """merge の元として読む接続先。管理者ではない読み取りロールで接続する。"""
        assert self._sock is not None and self.state == "ready" and self._reader
        return f"postgresql://{self._reader}@/{PG_DATABASE}?host={self._sock}&port={PG_PORT}"

    def start(self) -> None:
        """裏で復元を始める（実行中なら何もしない）。前の作業用の場所は消してから始める。"""
        if self.busy:
            return
        self.state, self.message, self.info = "fetching", None, RestoreInfo()
        self._task = asyncio.create_task(self._run())

    def cleanup_stale(self) -> None:
        """起動時に、前回の残り（作業用の場所の work と、unix ソケットの一時ディレクトリ）を消す"""
        shutil.rmtree(self._work, ignore_errors=True)
        for stale in Path(tempfile.gettempdir()).glob(f"{SOCKET_PREFIX}*"):
            shutil.rmtree(stale, ignore_errors=True)

    def redact(self, text: str) -> str:
        """メッセージから、鍵の値を伏せる（失敗の文に鍵が混ざらないように）。"""
        # 長い値から置き換える（短い値が長い値の一部のとき、長い値が壊れないように）。空の値は除く
        secret_values = sorted(
            (v for k, v in self._env.items() if any(p in k.upper() for p in _SECRET_NAME_PARTS)),
            key=len, reverse=True,
        )
        for value in secret_values:
            if value:
                text = text.replace(value, "***")
        return text

    async def reset(self) -> None:
        """実行中の処理を止め、PostgreSQL を止めて、作業用の場所を消す。"""
        if self._task and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        await self._stop_and_clean()
        self.state, self.message, self.info = "idle", None, RestoreInfo()

    # ── 中身 ──────────────────────────────────────────────────────────

    def _base_env(self) -> dict[str, str]:
        # recovery 自身の秘密は渡さない最小の環境。PostgreSQL にはこれだけを渡す（鍵は含まない）
        return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8"}

    async def _exec(
        self, *cmd: str, check: bool = True, with_secrets: bool = False
    ) -> tuple[int, str, str]:
        """コマンドを実行する。with_secrets=True（wal-g）のときだけ、WAL-G の設定を環境に渡す。"""
        env = self._base_env()
        if with_secrets:
            env.update(self._env)
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env
        )
        self._procs.add(proc)
        try:
            out, err = await proc.communicate()
        except asyncio.CancelledError:
            # 止められたら、子プロセスも止める（作業用の場所に書き続けないように）
            await _kill(proc)
            raise
        finally:
            self._procs.discard(proc)
        code = proc.returncode or 0
        if check and code != 0:
            tail = self.redact(err.decode("utf-8", errors="replace"))[-_TAIL:]
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
            self.state, self.message = "failed", self.redact(str(e) or type(e).__name__)
            await self._stop_and_clean()

    async def _fetch_base(self, pgdata: Path) -> None:
        _, out, _ = await self._exec(
            "wal-g", "backup-list", "--detail", "--json", with_secrets=True
        )
        try:
            backups = json.loads(out)
        except ValueError:
            raise RestoreError("wal-g backup-list の出力を読めませんでした") from None
        if not backups:
            raise RestoreError("R2 にバックアップがありません")
        latest = backups[-1]
        self.info.base_name = str(latest.get("backup_name") or latest.get("name") or "")
        self.info.base_time = str(latest.get("time") or latest.get("start_time") or "") or None
        needed = int(latest.get("uncompressed_size") or 0)
        if needed:
            self._work.mkdir(parents=True, exist_ok=True)
            required = int(needed * 1.1) + _SAFETY_MARGIN_BYTES
            free = free_bytes(self._work)
            if free < required:
                raise RestoreError(
                    f"作業用の領域の空きが足りません（要: 約 {required // 2**20} MB、"
                    f"空き: {free // 2**20} MB）。{self._work} の空きを増やしてください"
                )
        await self._exec("wal-g", "backup-fetch", str(pgdata), "LATEST", with_secrets=True)

    async def _replay(self, pgdata: Path) -> None:
        if pgdata.is_symlink() or not pgdata.is_dir():
            raise RestoreError("展開した PGDATA が、通常のディレクトリではありません")
        os.chmod(pgdata, 0o700)
        # 鍵は権限 600 のファイルに置き、restore_command の包みが読む（PostgreSQL の環境に置かない）
        secret_file = self._work / "walg-secrets.sh"
        lines = "".join(f"{k}={shlex.quote(v)}\nexport {k}\n" for k, v in self._env.items())
        _write_fresh(secret_file, lines, 0o600)
        script = self._work / "walg-fetch.sh"
        _write_fresh(script, _FETCH_SCRIPT.format(secrets=secret_file), 0o700)
        # unix ソケットのパスは長さに上限があるため、短い一時ディレクトリに置く
        self._sock = Path(tempfile.mkdtemp(prefix="r2r-"))
        control = await self._controldata(pgdata)
        # バックアップの設定（postgresql.conf・pg_hba.conf など）は使わず、最小の自前のものにする。
        # シンボリックリンクが仕込まれていても、リンク先（作業用 DB の設定など）を書かない
        _write_fresh(
            pgdata / "postgresql.conf",
            _CONF.format(sock=self._sock, port=PG_PORT, script=script, **control),
        )
        _write_fresh(pgdata / "postgresql.auto.conf", "")
        _write_fresh(pgdata / "pg_hba.conf", _HBA)
        _write_fresh(pgdata / "pg_ident.conf", "")
        (pgdata / "standby.signal").unlink(missing_ok=True)
        _write_fresh(pgdata / "recovery.signal", "")
        opts = (
            "-c archive_mode=off -c shared_preload_libraries= -c session_preload_libraries= "
            "-c local_preload_libraries= -c archive_library= "
            f"-c config_file={pgdata}/postgresql.conf -c hba_file={pgdata}/pg_hba.conf "
            f"-c ident_file={pgdata}/pg_ident.conf"
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
                    await self._create_reader(conn)
                    await self._read_info(conn)
                    return
            finally:
                await conn.close()
            await asyncio.sleep(1)

    async def _create_reader(self, conn: asyncpg.Connection) -> None:
        """昇格後の DB に、読み取りだけのロールを作る。merge の元の読み取りは、このロールで行う。

        復元した DB の関数・ビューが、管理者の権限で動くのを避けるため。名前はランダムにする
        （バックアップにある同名のロールと衝突・乗っ取りをさせない）。
        """
        name = f"r2_reader_{secrets.token_hex(6)}"
        await conn.execute(f'CREATE ROLE "{name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE')
        await conn.execute(f'GRANT pg_read_all_data TO "{name}"')
        self._reader = name

    async def _read_info(self, conn: asyncpg.Connection) -> None:
        with contextlib.suppress(asyncpg.PostgresError):
            self.info.alembic = await conn.fetchval("SELECT version_num FROM alembic_version")
        with contextlib.suppress(asyncpg.PostgresError):
            ts = await conn.fetchval("SELECT max(recorded_at) FROM readings")
            self.info.latest_reading = ts.isoformat() if ts else None

    async def _controldata(self, pgdata: Path) -> dict[str, str]:
        """元のサーバーの設定（復旧中の PostgreSQL は、これ以上でなければ再生が止まる）。"""
        _, out, _ = await self._exec("pg_controldata", str(pgdata), check=False)
        values = dict(_CONTROL_DEFAULTS)
        for line in out.splitlines():
            key, _, value = line.partition(":")
            name = _CONTROL_KEYS.get(key.strip())
            if name and value.strip():
                values[name] = value.strip()
        return values

    def _log_tail(self) -> str:
        with contextlib.suppress(OSError):
            # 先に伏せてから切る（切れ目で鍵が半端に残らないように）
            return self.redact((self._work / "pg.log").read_text(errors="replace"))[-_TAIL:]
        return ""

    async def _stop_and_clean(self) -> None:
        for proc in list(self._procs):  # 残っている子プロセス（wal-g など）を止める
            await _kill(proc)
        pgdata = self._work / "pgdata"
        if (pgdata / "postmaster.pid").exists():
            await self._exec("pg_ctl", "-D", str(pgdata), "-m", "fast", "-w", "stop", check=False)
        shutil.rmtree(self._work, ignore_errors=True)
        if self._sock is not None:
            shutil.rmtree(self._sock, ignore_errors=True)
            self._sock = None
        self._reader = None
