"""復旧ツールの Web 画面と API。

画面にはバックアップの中身（利用者のデータ）が出るため、全体に Basic 認証をかける。
今の DB へは読み取り専用で接続する（このツールから本番に書き込む機能は、段階 3 で別に設ける）。
"""

from __future__ import annotations

import asyncio
import csv
import io
import secrets
from collections.abc import AsyncIterator, Callable
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from recovery import compare, dbinfo
from recovery.config import Settings
from recovery.scratch import LoadError, Scratch, db_name_for
from recovery.sources import BackupSource, SourceError, validate_name, verify

CURRENT = "current"
MAX_PAGE_SIZE = 500
EXPORT_STATEMENT_TIMEOUT_MS = 600_000
STATIC_DIR = Path(__file__).parent / "static"

_basic = HTTPBasic(realm="FactorEye recovery")


def _require_auth(settings: Settings) -> Callable[[HTTPBasicCredentials], None]:
    def check(credentials: Annotated[HTTPBasicCredentials, Depends(_basic)]) -> None:
        # 一定時間で比べる（一致した文字数を応答時間から推測させない）
        user_ok = secrets.compare_digest(credentials.username.encode(), settings.username.encode())
        pass_ok = secrets.compare_digest(credentials.password.encode(), settings.password.encode())
        if not (user_ok and pass_ok):
            raise HTTPException(401, "認証に失敗しました", headers={"WWW-Authenticate": "Basic"})

    return check


def create_app(settings: Settings, source: BackupSource, scratch: Scratch) -> FastAPI:
    app = FastAPI(
        title="FactorEye recovery",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(_require_auth(settings))],
    )

    @app.exception_handler(SourceError)
    async def _source_error(_: Request, e: SourceError) -> JSONResponse:
        return JSONResponse({"detail": str(e)}, status_code=404)

    @app.exception_handler(dbinfo.TableNotFound)
    async def _table_error(_: Request, e: dbinfo.TableNotFound) -> JSONResponse:
        return JSONResponse({"detail": str(e)}, status_code=404)

    @app.exception_handler(OSError)
    async def _conn_error(_: Request, e: OSError) -> JSONResponse:
        # asyncpg は接続できないときに OSError（ConnectionRefusedError など）を投げる
        return JSONResponse({"detail": f"DB に接続できません: {e}"}, status_code=503)

    @app.exception_handler(asyncpg.PostgresError)
    async def _pg_error(_: Request, e: asyncpg.PostgresError) -> JSONResponse:
        return JSONResponse({"detail": f"DB のエラー: {e}"}, status_code=503)

    async def resolve_dsn(db: str) -> str:
        if db == CURRENT:
            if settings.target_dsn is None:
                raise HTTPException(404, "今の DB（TARGET_DATABASE_URL）が設定されていません")
            return settings.target_dsn
        validate_name(db)
        if not await scratch.is_loaded(db):
            raise HTTPException(409, f"先にバックアップを読み込んでください: {db}")
        return scratch.dsn_for(db)

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/info")
    async def info() -> dict[str, object]:
        return {"source": source.describe(), "target_configured": settings.target_dsn is not None}

    @app.get("/api/backups")
    async def list_backups() -> list[dict[str, object]]:
        entries = await asyncio.to_thread(source.list)
        loaded = await scratch.loaded_databases()
        return [
            {
                **asdict(e),
                "modified": e.modified.isoformat(),
                "loaded": db_name_for(e.name) in loaded,
            }
            for e in entries
        ]

    @app.post("/api/backups/{name}/load")
    async def load_backup(name: str, force: bool = False) -> dict[str, object]:
        """取得 → 検証 → 展開。sha256 が記録と合わないものは、force を付けない限り展開しない。"""
        validate_name(name)
        fetched = await asyncio.to_thread(source.fetch, name)
        try:
            result = await asyncio.to_thread(verify, fetched)
            body: dict[str, object] = {"verify": {**asdict(result), "ok": result.ok}}
            if not result.gzip_ok or (result.checksum == "mismatch" and not force):
                raise HTTPException(422, {"message": result.error, **body})
            try:
                await scratch.load(name, fetched.path)
            except LoadError as e:
                raise HTTPException(422, {"message": str(e), **body}) from e
            return {**body, "loaded": True}
        finally:
            if fetched.temporary:
                fetched.path.unlink(missing_ok=True)

    @app.delete("/api/backups/{name}/load")
    async def unload_backup(name: str) -> dict[str, object]:
        await scratch.drop(validate_name(name))
        return {"loaded": False}

    @app.get("/api/db/{db}/summary")
    async def summary(db: str) -> dict[str, object]:
        async with dbinfo.read_only(await resolve_dsn(db)) as conn:
            s = await dbinfo.summarize(conn)
        return _jsonable(asdict(s))

    @app.get("/api/db/{db}/workspaces")
    async def workspaces(db: str) -> list[dict[str, object]]:
        async with dbinfo.read_only(await resolve_dsn(db)) as conn:
            rows = await dbinfo.workspaces(conn)
        return [_jsonable(asdict(w)) for w in rows]

    @app.get("/api/db/{db}/tables")
    async def tables(db: str) -> list[str]:
        async with dbinfo.read_only(await resolve_dsn(db)) as conn:
            return await dbinfo.list_tables(conn)

    @app.get("/api/db/{db}/tables/{table}")
    async def rows(
        db: str,
        table: str,
        workspace_id: UUID | None = None,
        time_from: Annotated[datetime | None, Query(alias="from")] = None,
        time_to: Annotated[datetime | None, Query(alias="to")] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> dict[str, object]:
        f = dbinfo.RowFilter(workspace_id, time_from, time_to)
        async with dbinfo.read_only(await resolve_dsn(db)) as conn:
            page = await dbinfo.fetch_rows(conn, table, f, limit, offset)
        return asdict(page)

    @app.get("/api/db/{db}/export/{table}.csv")
    async def export_csv(
        db: str,
        table: str,
        workspace_id: UUID | None = None,
        time_from: Annotated[datetime | None, Query(alias="from")] = None,
        time_to: Annotated[datetime | None, Query(alias="to")] = None,
    ) -> StreamingResponse:
        dsn = await resolve_dsn(db)
        f = dbinfo.RowFilter(workspace_id, time_from, time_to)
        # 応答を返し始める前に、テーブルの有無などの誤りを 404 として返す
        async with dbinfo.read_only(dsn) as conn:
            if table not in await dbinfo.list_tables(conn):
                raise dbinfo.TableNotFound(f"テーブルがありません: {table}")

        async def generate() -> AsyncIterator[str]:
            # Excel で文字化けしないよう、先頭に BOM を付ける
            yield "﻿"
            # 全件の書き出しは時間がかかるため、上限を長くする
            # （カーソルの 1 回の読み出しごとの上限）
            async with dbinfo.read_only(dsn, EXPORT_STATEMENT_TIMEOUT_MS) as conn:
                async for row in dbinfo.iter_rows(conn, table, f):
                    buf = io.StringIO()
                    csv.writer(buf).writerow(row)
                    yield buf.getvalue()

        label = "current" if db == CURRENT else db.removesuffix(".sql.gz")
        return StreamingResponse(
            generate(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{label}-{table}.csv"'},
        )

    @app.get("/api/backups/{name}/compare")
    async def compare_with_current(name: str) -> dict[str, object]:
        backup_dsn = await resolve_dsn(name)
        current_dsn = await resolve_dsn(CURRENT)
        async with dbinfo.read_only(backup_dsn) as conn:
            b_sum, b_ws = await dbinfo.summarize(conn), await dbinfo.workspaces(conn)
        async with dbinfo.read_only(current_dsn) as conn:
            c_sum, c_ws = await dbinfo.summarize(conn), await dbinfo.workspaces(conn)
        return {
            "backup": _jsonable(asdict(b_sum)),
            "current": _jsonable(asdict(c_sum)),
            "tables": [{**asdict(t), "diff": t.diff} for t in compare.compare_tables(b_sum, c_sum)],
            "workspaces": [asdict(w) for w in compare.compare_workspaces(b_ws, c_ws)],
        }

    return app


def _jsonable(d: dict[str, object]) -> dict[str, object]:
    return {k: dbinfo.to_jsonable(k, v) for k, v in d.items()}
