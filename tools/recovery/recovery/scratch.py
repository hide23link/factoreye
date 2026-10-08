"""バックアップを作業用の Postgres に展開する。

SQL を自分で読み解かず、本物の Postgres に流し込んでから SQL で調べる。
pg_dump の出力をそのまま正しく解釈できるのは Postgres だけだから。
バックアップ 1 つにつき DB を 1 つ作る（名前は bk_<名前のハッシュ>）。本番の DB には触らない。
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import asyncpg

DB_PREFIX = "bk_"
# pg_dump は各オブジェクトの所有者を `ALTER ... OWNER TO <ロール>;` で書く。
# 作業用の Postgres にそのロールが無いと流し込みが止まるため、先に作っておく
_OWNER_RE = re.compile(rb'OWNER TO "?([A-Za-z_][A-Za-z0-9_$]*)"?;')
_STDERR_TAIL = 2000


class LoadError(Exception):
    pass


def db_name_for(backup_name: str) -> str:
    return DB_PREFIX + hashlib.sha256(backup_name.encode()).hexdigest()[:16]


def dsn_with_database(dsn: str, database: str) -> str:
    parts = urlsplit(dsn)
    return urlunsplit(parts._replace(path="/" + database))


def scan_owner_roles(path: Path) -> set[str]:
    roles: set[str] = set()
    with gzip.open(path, "rb") as f:
        for line in f:
            if b"OWNER TO" in line:
                roles.update(m.decode() for m in _OWNER_RE.findall(line))
    return roles


class Scratch:
    def __init__(self, admin_dsn: str) -> None:
        self._admin_dsn = admin_dsn
        self._locks: dict[str, asyncio.Lock] = {}

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
                "SELECT datname FROM pg_database WHERE datname LIKE $1", DB_PREFIX + "%"
            )
        return {r["datname"] for r in rows}

    async def is_loaded(self, backup_name: str) -> bool:
        return db_name_for(backup_name) in await self.loaded_databases()

    async def drop(self, backup_name: str) -> None:
        async with self._admin() as conn:
            # 名前は db_name_for が作る英数字だけなので、識別子としてそのまま埋め込める
            await conn.execute(f'DROP DATABASE IF EXISTS "{db_name_for(backup_name)}" WITH (FORCE)')

    async def load(self, backup_name: str, path: Path) -> None:
        """展開する。途中で失敗したら、半端な DB を残さずに消す。"""
        lock = self._locks.setdefault(backup_name, asyncio.Lock())
        async with lock:
            if await self.is_loaded(backup_name):
                return
            roles = await asyncio.to_thread(scan_owner_roles, path)
            db = db_name_for(backup_name)
            async with self._admin() as conn:
                for role in sorted(roles):
                    exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", role)
                    if not exists:
                        await conn.execute(f'CREATE ROLE "{role}" NOLOGIN')
                await conn.execute(f'CREATE DATABASE "{db}"')
            try:
                await self._psql_restore(path, self.dsn_for(backup_name))
            except BaseException:
                await self.drop(backup_name)
                raise

    async def _psql_restore(self, path: Path, dsn: str) -> None:
        # ON_ERROR_STOP: 1 行でも失敗したら止める。一部だけ入った DB を「読めた」と見せないため
        proc = await asyncio.create_subprocess_exec(
            "psql", "--no-psqlrc", "--quiet", "-v", "ON_ERROR_STOP=1", "-d", dsn,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdin is not None and proc.stderr is not None
        stderr_task = asyncio.create_task(proc.stderr.read())
        try:
            with gzip.open(path, "rb") as f:
                while chunk := await asyncio.to_thread(f.read, 1024 * 1024):
                    proc.stdin.write(chunk)
                    await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass  # psql が先に止まった。理由は下で stderr から伝える
        finally:
            proc.stdin.close()
        stderr = await stderr_task
        code = await proc.wait()
        if code != 0:
            tail = stderr.decode("utf-8", errors="replace")[-_STDERR_TAIL:]
            raise LoadError(f"展開に失敗しました（psql 終了コード {code}）: {tail}")
