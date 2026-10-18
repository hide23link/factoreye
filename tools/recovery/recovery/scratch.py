"""バックアップを作業用の Postgres に展開する。

SQL を自分で読み解かず、本物の Postgres に流し込んでから SQL で調べる。
pg_dump の出力をそのまま正しく解釈できるのは Postgres だけだから。
バックアップ 1 つにつき DB を 1 つ作る（名前は bk_<名前のハッシュ>）。本番の DB には触らない。

バックアップは、乗っ取られた本番で書き換えられている前提で扱う（.sha256 も一緒に作り直せるため、
検証だけでは防げない）。そのため展開では、次の 3 つでコードの実行を防ぐ:
- psql のメタコマンド（\\! など）を止める（\\restrict）
- 管理者ではないロール（bk_restorer）で流し込む（COPY ... PROGRAM などを使えない）
- psql に秘密の環境変数（TARGET_DATABASE_URL・AWS の鍵など）を渡さない

【誰が使うか】app.py、main.py、snapshot.py が読み込む。
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import os
import re
import secrets
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import asyncpg

DB_PREFIX = "bk_"
# 展開の途中の DB。成功してから bk_ に名前を変える（途中で落ちたものを「展開済み」に見せない）
TMP_PREFIX = "bktmp_"
RESTORE_ROLE = "bk_restorer"
# pg_dump は各オブジェクトの所有者を `ALTER ... OWNER TO <ロール>;` で書く。
# 作業用の Postgres にそのロールが無いと流し込みが止まるため、先に作っておく
_OWNER_RE = re.compile(rb'OWNER TO "?([A-Za-z_][A-Za-z0-9_$]*)"?;')
# ALTER DEFAULT PRIVILEGES FOR ROLE <ロール> は、そのロールに属していないと実行できない
# （所有者と同じ扱いにする）
_FOR_ROLE_RE = re.compile(rb'FOR ROLE "?([A-Za-z_][A-Za-z0-9_$]*)"?')
# GRANT ... TO <ロール>; / REVOKE ... FROM <ロール>; のロール（例: 読み取り専用のロール）。
# 権限を渡す先として在ればよい（展開用のロールは属さない）
_GRANTEE_RE = re.compile(
    rb"^(?:GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) .* (?:TO|FROM) (.+);\s*$"
)
_ROLE_NAME_RE = re.compile(r'^"?([A-Za-z_][A-Za-z0-9_$]*)"?$')
_BUILTIN_GRANTEES = frozenset({"PUBLIC", "CURRENT_USER", "CURRENT_ROLE", "SESSION_USER"})
# pg_dump 15.14 以降が書く \restrict / \unrestrict。こちらで付ける \restrict と重なるため取り除く
_DUMP_RESTRICT_RE = re.compile(rb"^\\(?:un)?restrict [A-Za-z0-9]+\r?\n?$")
_COPY_START_RE = re.compile(rb"^COPY .* FROM stdin;\r?\n?$")
_COPY_END = (b"\\.\n", b"\\.\r\n", b"\\.")
_STDERR_TAIL = 2000


class LoadError(Exception):
    pass


def db_name_for(backup_name: str) -> str:
    return DB_PREFIX + hashlib.sha256(backup_name.encode()).hexdigest()[:16]


def _tmp_name_for(backup_name: str) -> str:
    return TMP_PREFIX + db_name_for(backup_name).removeprefix(DB_PREFIX)


def dsn_with_database(dsn: str, database: str) -> str:
    parts = urlsplit(dsn)
    return urlunsplit(parts._replace(path="/" + database))


def dsn_with_user(dsn: str, user: str) -> str:
    """接続先はそのままに、ユーザーだけを変える（パスワードは PGPASSWORD で渡す）。"""
    parts = urlsplit(dsn)
    host = parts.netloc.rsplit("@", 1)[-1]
    return urlunsplit(parts._replace(netloc=f"{user}@{host}"))


def scan_roles(path: Path) -> tuple[set[str], set[str]]:
    """バックアップが使うロールを、(所有者のロール, 権限を渡す先だけのロール) に分けて返す。"""
    owners: set[str] = set()
    grantees: set[str] = set()
    with gzip.open(path, "rb") as f:
        for line in f:
            if b"OWNER TO" in line:
                owners.update(m.decode() for m in _OWNER_RE.findall(line))
            if line.startswith((b"GRANT ", b"REVOKE ", b"ALTER DEFAULT PRIVILEGES ")):
                owners.update(m.decode() for m in _FOR_ROLE_RE.findall(line))
                m = _GRANTEE_RE.match(line)
                if m:
                    for part in m.group(1).decode().split(","):
                        name = _ROLE_NAME_RE.match(part.strip().removesuffix(" WITH GRANT OPTION"))
                        if name and name.group(1).upper() not in _BUILTIN_GRANTEES:
                            grantees.add(name.group(1))
    return owners, grantees - owners


def guarded_lines(path: Path, restrict_key: str) -> Iterator[bytes]:
    """psql に流す行。先頭で \\restrict を掛け、それ以外のメタコマンドは通さない。

    \\restrict の後は、psql 自身が \\unrestrict <鍵> 以外のメタコマンドを拒む
    （鍵は毎回の乱数で、バックアップの作り手には分からない）。
    COPY のデータ行（\\N など）はメタコマンドではないので通す。
    """
    yield f"\\restrict {restrict_key}\n".encode()
    in_copy = False
    with gzip.open(path, "rb") as f:
        for line in f:
            if in_copy:
                if line in _COPY_END:
                    in_copy = False
                yield line
            elif line.startswith(b"\\"):
                if _DUMP_RESTRICT_RE.match(line):
                    continue
                raise LoadError(f"バックアップにメタコマンドがあります: {line[:80]!r}")
            else:
                if _COPY_START_RE.match(line):
                    in_copy = True
                yield line


class Scratch:
    def __init__(self, admin_dsn: str) -> None:
        self._admin_dsn = admin_dsn
        self._locks: dict[str, asyncio.Lock] = {}
        # 展開用のロールのパスワード。起動ごとに作り直す（どこにも保存しない）
        self._restore_password = secrets.token_hex(24)

    def dsn_for(self, backup_name: str) -> str:
        return dsn_with_database(self._admin_dsn, db_name_for(backup_name))

    @asynccontextmanager
    async def _admin(self) -> AsyncIterator[asyncpg.Connection]:
        conn = await asyncpg.connect(self._admin_dsn)
        try:
            yield conn
        finally:
            await conn.close()

    async def loaded_databases(self) -> set[str]:
        async with self._admin() as conn:
            rows = await conn.fetch(
                "SELECT datname FROM pg_database WHERE starts_with(datname, $1)", DB_PREFIX
            )
        return {r["datname"] for r in rows}

    async def is_loaded(self, backup_name: str) -> bool:
        return db_name_for(backup_name) in await self.loaded_databases()

    async def drop(self, backup_name: str) -> None:
        async with self._admin() as conn:
            # 名前は db_name_for が作る英数字だけなので、識別子としてそのまま埋め込める
            for db in (db_name_for(backup_name), _tmp_name_for(backup_name)):
                await conn.execute(f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)')

    async def load(self, backup_name: str, path: Path) -> None:
        """展開する。途中で失敗したら、半端な DB を残さずに消す。"""
        lock = self._locks.setdefault(backup_name, asyncio.Lock())
        async with lock:
            if await self.is_loaded(backup_name):
                return
            roles, grantees = await asyncio.to_thread(scan_roles, path)
            tmp = _tmp_name_for(backup_name)
            async with self._admin() as conn:
                await self._prepare_roles(conn, roles)
                for role in sorted(grantees):
                    if role == RESTORE_ROLE:
                        raise LoadError(f"バックアップで使えないロールです: {role}")
                    if not await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", role):
                        await conn.execute(f'CREATE ROLE "{role}" NOLOGIN NOSUPERUSER')
                # 前回の途中で落ちた残りがあれば消してから作る
                await conn.execute(f'DROP DATABASE IF EXISTS "{tmp}" WITH (FORCE)')
                await conn.execute(f'CREATE DATABASE "{tmp}" OWNER "{RESTORE_ROLE}"')
            try:
                await self._grant_schema(tmp, roles)
                await self._psql_restore(path, dsn_with_database(self._admin_dsn, tmp))
                async with self._admin() as conn:
                    await conn.execute(
                        f'ALTER DATABASE "{tmp}" RENAME TO "{db_name_for(backup_name)}"'
                    )
            except BaseException:
                await self.drop(backup_name)
                raise

    async def _prepare_roles(self, conn: asyncpg.Connection, owners: set[str]) -> None:
        exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", RESTORE_ROLE)
        verb = "ALTER" if exists else "CREATE"
        # パスワードは token_hex（英数字だけ）なので、そのまま埋め込める
        await conn.execute(
            f'{verb} ROLE "{RESTORE_ROLE}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
            f" PASSWORD '{self._restore_password}'"
        )
        for role in sorted(owners):
            if role == RESTORE_ROLE:
                raise LoadError(f"バックアップの所有者に使えないロールです: {role}")
            row = await conn.fetchrow("SELECT rolsuper FROM pg_roles WHERE rolname = $1", role)
            if row is None:
                await conn.execute(f'CREATE ROLE "{role}" NOLOGIN NOSUPERUSER')
            elif row["rolsuper"]:
                # 所有者のロールに入ると、そのロールの権限で動ける。管理者のロールには入らせない
                raise LoadError(f"所有者が作業用 Postgres の管理者と同じロールです: {role}")
            # 所有者を ALTER ... OWNER TO で変えるには、そのロールに属している必要がある
            await conn.execute(f'GRANT "{role}" TO "{RESTORE_ROLE}"')

    async def _grant_schema(self, database: str, owners: set[str]) -> None:
        # ALTER ... OWNER TO で所有者にするロールは、スキーマ public に CREATE の権限が要る
        conn = await asyncpg.connect(dsn_with_database(self._admin_dsn, database))
        try:
            for role in sorted(owners):
                await conn.execute(f'GRANT USAGE, CREATE ON SCHEMA public TO "{role}"')
        finally:
            await conn.close()

    async def _psql_restore(self, path: Path, dsn: str) -> None:
        # ON_ERROR_STOP: 1 行でも失敗したら止める。一部だけ入った DB を「読めた」と見せないため。
        # 環境変数は最小限にする（バックアップから秘密を読み出されないように）
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LANG": "C.UTF-8",
            "PGPASSWORD": self._restore_password,
        }
        proc = await asyncio.create_subprocess_exec(
            "psql", "--no-psqlrc", "--quiet", "-v", "ON_ERROR_STOP=1",
            "-d", dsn_with_user(dsn, RESTORE_ROLE),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        assert proc.stdin is not None and proc.stderr is not None
        stderr_task = asyncio.create_task(proc.stderr.read())
        lines = guarded_lines(path, secrets.token_hex(16))
        rejected: LoadError | None = None
        try:
            while batch := await asyncio.to_thread(_next_batch, lines):
                proc.stdin.write(batch)
                await proc.stdin.drain()
        except LoadError as e:
            rejected = e
            proc.kill()
        except (BrokenPipeError, ConnectionResetError):
            pass  # psql が先に止まった。理由は下で stderr から伝える
        finally:
            proc.stdin.close()
        stderr = await stderr_task
        code = await proc.wait()
        if rejected is not None:
            raise rejected
        if code != 0:
            tail = stderr.decode("utf-8", errors="replace")[-_STDERR_TAIL:]
            raise LoadError(f"展開に失敗しました（psql 終了コード {code}）: {tail}")


def _next_batch(lines: Iterator[bytes], size: int = 1024 * 1024) -> bytes:
    buf = bytearray()
    for line in lines:
        buf += line
        if len(buf) >= size:
            break
    return bytes(buf)
