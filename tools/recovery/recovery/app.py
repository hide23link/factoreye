"""復旧ツールの Web 画面と API。

画面にはバックアップの中身（利用者のデータ）が出るため、全体に Basic 認証をかける。
ただし RECOVERY_AUTH_DISABLED=1 のときは外す
（LAN だけに公開するラズパイの運用。書き戻しができるので、公開範囲に注意）。
今の DB へは読み取り専用で接続する（このツールから本番に書き込む機能は、段階 3 で別に設ける）。

【誰が使うか】main.py が読み込む。

【誰が使うか】main.py が、Web アプリとして組み立てる。
"""

from __future__ import annotations

import asyncio
import contextlib
import csv
import io
import secrets
import socket
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
from pydantic import BaseModel, Field

from recovery import compare, dbinfo, merge
from recovery.config import Settings
from recovery.scratch import LoadError, Scratch, db_name_for
from recovery.snapshot import SnapshotError, dump_database
from recovery.sources import (
    BackupSource,
    HandoffSource,
    SourceError,
    validate_handoff_name,
    validate_name,
    verify,
)
from recovery.walg import R2Restore

CURRENT = "current"
MAX_PAGE_SIZE = 500
EXPORT_STATEMENT_TIMEOUT_MS = 600_000
STATIC_DIR = Path(__file__).parent / "static"

_basic = HTTPBasic(realm="FactorEye recovery")


class MergeRequest(BaseModel):
    workspace_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    include_self_hosted: bool = False
    time_from: datetime | None = Field(default=None, alias="from")
    time_to: datetime | None = Field(default=None, alias="to")
    # 書き戻し先（OSS 版 ⇄ SaaS 版で所属を変えるとき）。省略すると元と同じ所属
    into_workspace_id: UUID | None = None
    into_self_hosted: bool = False
    # false: 試行（件数を確かめて取り消す）、true: 実行（直前に今の DB の控えを取ってから書き込む）
    apply: bool = False
    # 実行のとき: 画面で確認した試行の件数（足す行の合計）。実行の直前の試行と違えば中止する。
    # 試行の後に今の DB が変わり、確認した内容と違うものを書き込まないように
    expected_inserted: int | None = Field(default=None, ge=0)


class FailbackRequest(BaseModel):
    # false: 試算（書き込まずに追加される件数を数える）
    # true: 実行（直前の控えを取ってから書き込む）
    apply: bool = False
    # 実行のとき: 試算で確認した、足す行の合計。実行の直前の試算と違えば中止する
    expected_inserted: int | None = Field(default=None, ge=0)


class R2FailbackRequest(FailbackRequest):
    # 合わせて合流する引き継ぎ（handoff-factoreye-…）。省略すると R2 の復元だけ
    handoff: str | None = None


def _require_auth(settings: Settings) -> Callable[[HTTPBasicCredentials], None]:
    def check(credentials: Annotated[HTTPBasicCredentials, Depends(_basic)]) -> None:
        # 一定時間で比べる（一致した文字数を応答時間から推測させない）
        user_ok = secrets.compare_digest(credentials.username.encode(), settings.username.encode())
        pass_ok = secrets.compare_digest(credentials.password.encode(), settings.password.encode())
        if not (user_ok and pass_ok):
            raise HTTPException(401, "認証に失敗しました", headers={"WWW-Authenticate": "Basic"})

    return check


def describe_os_error(e: OSError) -> tuple[str, int]:
    """OSError の原因を区別して、利用者に見せる文言と HTTP ステータスを返す。

    asyncpg は接続できないとき OSError の仲間（ConnectionRefusedError、socket.gaierror、
    TimeoutError）を投げる。一方、バックアップのファイルを読めないときは PermissionError など
    （BACKUP_GID の誤りなど）になる。これらを「DB に接続できません」とひとまとめにしない。
    """
    if isinstance(e, PermissionError):
        return (
            f"ファイルを読む権限がありません: {e.filename or e}。"
            "バックアップのファイルのグループと BACKUP_GID が合っているか確認してください",
            500,
        )
    if isinstance(e, FileNotFoundError):
        return f"ファイルまたはディレクトリが見つかりません: {e.filename or e}", 500
    if isinstance(e, ConnectionError | TimeoutError | socket.gaierror):
        return f"DB に接続できません: {e}", 503
    return f"入出力のエラー（DB の接続ではありません）: {e}", 500


def create_app(
    settings: Settings,
    source: BackupSource,
    scratch: Scratch,
    handoff: HandoffSource | None = None,
    r2: R2Restore | None = None,
) -> FastAPI:
    app = FastAPI(
        title="FactorEye recovery",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(_require_auth(settings))] if settings.auth_enabled else [],
    )

    merge_lock = asyncio.Lock()

    @app.exception_handler(merge.MergeError)
    async def _merge_error(_: Request, e: merge.MergeError) -> JSONResponse:
        return JSONResponse({"detail": str(e)}, status_code=422)

    @app.exception_handler(SnapshotError)
    async def _snapshot_error(_: Request, e: SnapshotError) -> JSONResponse:
        return JSONResponse({"detail": str(e)}, status_code=503)

    @app.exception_handler(SourceError)
    async def _source_error(_: Request, e: SourceError) -> JSONResponse:
        return JSONResponse({"detail": str(e)}, status_code=404)

    @app.exception_handler(dbinfo.TableNotFound)
    async def _table_error(_: Request, e: dbinfo.TableNotFound) -> JSONResponse:
        return JSONResponse({"detail": str(e)}, status_code=404)

    @app.exception_handler(OSError)
    async def _os_error(_: Request, e: OSError) -> JSONResponse:
        detail, status = describe_os_error(e)
        return JSONResponse({"detail": detail}, status_code=status)

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
        return {
            "source": source.describe(),
            "target_configured": settings.target_dsn is not None,
            "merge_enabled": settings.target_write_dsn is not None,
            "handoff_configured": handoff is not None,
            "r2_configured": r2 is not None,
            "r2_error": settings.walg_error,
            "target_mode": settings.target_mode,
        }

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

    async def run_merge_multi(
        sources: list[tuple[str, merge.MergeSelection]],
        apply: bool,
        expected_inserted: int | None,
    ) -> dict[str, object]:
        """試算または実行。merge_lock を持った状態で呼ぶ。

        複数の元は、1 つのトランザクションで順に足す。
        """
        write_dsn = settings.target_write_dsn
        assert write_dsn is not None

        async def run(do_apply: bool) -> list[merge.MergeResult]:
            async with contextlib.AsyncExitStack() as stack:
                conns = [
                    (await stack.enter_async_context(dbinfo.read_only(dsn)), sel)
                    for dsn, sel in sources
                ]
                dst = await stack.enter_async_context(merge.connect_target(write_dsn))
                return await merge.merge_many(conns, dst, do_apply, settings.target_mode)

        snapshot = None
        if apply:
            if expected_inserted is None:
                raise HTTPException(422, "先に試行して、件数を確かめてください")
            planned = sum(t.inserted for r in await run(False) for t in r.tables)
            if planned != expected_inserted:
                raise HTTPException(
                    409,
                    f"試行の後に今の DB が変わりました（確認した {expected_inserted} 行"
                    f" → 今は {planned} 行）。もう一度試行してください",
                )
            # 試行で問題が無くても、実行の直前の状態を必ず控える
            snapshot = await dump_database(write_dsn, settings.snapshot_dir)
        results = await run(apply)
        body: dict[str, object] = {
            "applied": apply,
            "tables": [asdict(t) for t in _aggregate(results)],
            "snapshot": snapshot.name if snapshot else None,
        }
        if len(results) > 1:
            body["parts"] = [{"tables": [asdict(t) for t in r.tables]} for r in results]
        return body

    async def run_merge(
        backup_dsn: str, sel: merge.MergeSelection, apply: bool, expected_inserted: int | None
    ) -> dict[str, object]:
        return await run_merge_multi([(backup_dsn, sel)], apply, expected_inserted)

    @app.post("/api/backups/{name}/merge")
    async def merge_into_current(name: str, req: MergeRequest) -> dict[str, object]:
        """選んだワークスペースの、今の DB に無い行だけを書き戻す。"""
        if settings.target_write_dsn is None:
            raise HTTPException(
                403, "書き戻しは無効です（TARGET_WRITE_DATABASE_URL が設定されていません）"
            )
        backup_dsn = await resolve_dsn(name)
        sel = merge.MergeSelection(
            req.workspace_ids, req.include_self_hosted, req.time_from, req.time_to,
            req.into_workspace_id, req.into_self_hosted,
        )
        # 書き戻しは同時に 1 つだけ（控えと書き込みの順番が入れ違わないように）
        async with merge_lock:
            return await run_merge(backup_dsn, sel, req.apply, req.expected_inserted)

    def require_handoff() -> HandoffSource:
        if handoff is None:
            raise HTTPException(
                404, "引き継ぎの読み込み元（HANDOFF_SOURCE）が設定されていません"
            )
        return handoff

    @app.get("/api/handoffs")
    async def list_handoffs() -> dict[str, object]:
        """控えが置いた縮小ダンプの一覧（新しい順）。最新の 1 つだけ、記録（latest.json）が付く。"""
        h = require_handoff()
        entries = await asyncio.to_thread(h.list)
        latest = await asyncio.to_thread(h.latest)
        items = []
        for e in entries:
            info = asdict(latest[1]) if latest and latest[0] == e.name else {}
            items.append({
                "name": e.name,
                "size": e.size,
                "modified": e.modified.isoformat(),
                # 縮小ダンプの置き場（handoff-inc/）には縮小ダンプだけが置かれる。
                # 記録が無い古いものは、kind・watermark が分からない（None）
                "kind": info.get("kind"),
                "watermark": info.get("watermark"),
                "alembic": info.get("alembic"),
                "instance": info.get("instance"),
                "region": info.get("region"),
                "created_at": info.get("created_at"),
            })
        return {"source": h.describe(), "items": items}

    @contextlib.asynccontextmanager
    async def loaded_handoff(name: str) -> AsyncIterator[tuple[str, str]]:
        """引き継ぎを取得・検証・展開して、(DB の DSN, checksum) を渡す。出るときに消す。"""
        h = require_handoff()
        validate_handoff_name(name)
        fetched = await asyncio.to_thread(h.fetch, name)
        try:
            result = await asyncio.to_thread(verify, fetched)
            if not result.ok:
                # 引き継ぎは自動で作られる。検証に通らないものは、force なしで使わない
                raise HTTPException(
                    422, f"引き継ぎが壊れています（{result.error}）。書き戻しません"
                )
            if result.checksum != "ok":
                # .sha256 が無いものは、改ざん・書きかけを見分けられない。使わない
                raise HTTPException(
                    422, "引き継ぎの .sha256 がありません。検証できないため、書き戻しません"
                )
            latest = await asyncio.to_thread(h.latest)
            if latest is None:
                # 種類を確かめられないものは使わない（latest.json が無い・読めない）
                raise HTTPException(
                    422, "latest.json を読めず、引き継ぎの種類を確かめられません。書き戻しません"
                )
            if latest[0] != name:
                # 記録は最新の 1 件だけ。古いものは、種類（全体のダンプかなど）を確かめられない
                raise HTTPException(
                    422, "最新の引き継ぎだけ書き戻せます。一覧の先頭を選んでください"
                )
            if latest[1].kind != "reduced":
                # 縮小ダンプ以外（全体のダンプなど）は、この経路の想定外。何も書かない
                raise HTTPException(
                    422,
                    f"引き継ぎの種類が縮小ダンプ（reduced）ではありません"
                    f"（kind={latest[1].kind}）。書き戻しません",
                )
            had_loaded = await scratch.is_loaded(name)
            try:
                try:
                    await scratch.load(name, fetched.path)
                except LoadError as e:
                    raise HTTPException(422, f"引き継ぎを展開できません: {e}") from e
                yield scratch.dsn_for(name), result.checksum
            finally:
                if not had_loaded:
                    await scratch.drop(name)
        finally:
            if fetched.temporary:
                fetched.path.unlink(missing_ok=True)

    def schema_mismatch(e: merge.SchemaMismatch) -> HTTPException:
        return HTTPException(
            409,
            {
                "code": "schema_mismatch",
                "message": str(e),
                "handoff_alembic": e.backup,
                "current_alembic": e.current,
            },
        )

    def require_write() -> None:
        if settings.target_write_dsn is None:
            raise HTTPException(
                403, "書き戻しは無効です（TARGET_WRITE_DATABASE_URL が設定されていません）"
            )

    @app.post("/api/handoffs/{name}/failback")
    async def failback(name: str, req: FailbackRequest) -> dict[str, object]:
        """引き継ぎ（縮小ダンプ）の、今の DB に無い行だけを書き戻す。

        取得 → 検証（壊れていれば中止）→ 展開 → 書き戻し（試算・実行は /merge と同じ処理）
        → 展開を消す。対象は、縮小ダンプの全ワークスペース
        （OSS 版の今の DB なら、ワークスペースに属さないデータ）。
        """
        require_write()
        require_handoff()
        validate_handoff_name(name)
        async with merge_lock, loaded_handoff(name) as (backup_dsn, checksum):
            sel = await _handoff_selection(backup_dsn, settings.target_mode)
            if not sel.workspace_ids and not sel.include_self_hosted:
                raise HTTPException(422, "引き継ぎにワークスペースがありません")
            try:
                body = await run_merge(backup_dsn, sel, req.apply, req.expected_inserted)
            except merge.SchemaMismatch as e:
                raise schema_mismatch(e) from e
        return {**body, "handoff": name, "checksum": checksum}

    # ── R2 の WAL-G のバックアップからの復旧（本番が消えた・データが不完全なとき） ──────────

    def require_r2() -> R2Restore:
        if r2 is None:
            raise HTTPException(
                404, "R2 からの復旧の設定（WALG_ENV_FILE）がありません"
            )
        return r2

    @app.get("/api/r2restore")
    async def r2_status() -> dict[str, object]:
        if r2 is None:
            return {
                "configured": False, "state": "idle", "message": settings.walg_error, "info": None,
            }
        return {"configured": True, **r2.status()}

    @app.post("/api/r2restore/start")
    async def r2_start() -> dict[str, object]:
        """R2 の最新のベースを取り、WAL を最新まで再生する（裏で進む。状態は GET で見る）。"""
        require_write()
        job = require_r2()
        if job.busy:
            raise HTTPException(409, "R2 からの復元は、すでに進んでいます")
        if job.state == "ready":
            # 準備完了の作業用 DB は書き戻しの入力。作り直すと、進行中の書き戻しの入力が消える
            raise HTTPException(
                409, "作業用の復元が残っています。使い終わったら「作業用の復元を消す」で消します"
            )
        job.start()
        return {"configured": True, **job.status()}

    @app.delete("/api/r2restore")
    async def r2_reset() -> dict[str, object]:
        job = require_r2()
        async with merge_lock:
            await job.reset()
        return {"configured": True, **job.status()}

    @app.post("/api/r2restore/failback")
    async def r2_failback(req: R2FailbackRequest) -> dict[str, object]:
        """R2 から復元した DB（と、あれば引き継ぎ）の、今の DB に無い行だけを足す。

        今の DB が空（作り直した直後。スキーマだけある）でも、一部だけでも動く。
        R2 → 引き継ぎの順に、1 つのトランザクションで足す。
        """
        require_write()
        job = require_r2()
        if job.state != "ready":
            raise HTTPException(409, "先に R2 からの復元を終えてください（状態を確認）")
        async with merge_lock, contextlib.AsyncExitStack() as stack:
            sources = [(job.dsn, await _handoff_selection(job.dsn, settings.target_mode))]
            if req.handoff:
                h_dsn, _ = await stack.enter_async_context(loaded_handoff(req.handoff))
                sources.append((h_dsn, await _handoff_selection(h_dsn, settings.target_mode)))
            if not any(sel.workspace_ids or sel.include_self_hosted for _, sel in sources):
                raise HTTPException(422, "復旧するワークスペースがありません")
            sources = [
                (d, sel) for d, sel in sources if sel.workspace_ids or sel.include_self_hosted
            ]
            try:
                body = await run_merge_multi(sources, req.apply, req.expected_inserted)
            except merge.SchemaMismatch as e:
                raise schema_mismatch(e) from e
        return {**body, "r2": job.status()["info"], "handoff": req.handoff}

    return app


def _aggregate(results: list[merge.MergeResult]) -> list[merge.TableResult]:
    """複数の元の結果を、表ごとに合計する（表の順は最初に出た順）。"""
    out: dict[str, merge.TableResult] = {}
    for r in results:
        for t in r.tables:
            old = out.get(t.table)
            if old is None:
                out[t.table] = t
                continue
            note = old.note or t.note
            out[t.table] = merge.TableResult(
                t.table, old.source + t.source, old.inserted + t.inserted,
                old.existing + t.existing, note, old.closed + t.closed,
            )
    return list(out.values())


async def _handoff_selection(dsn: str, target_mode: str | None) -> merge.MergeSelection:
    """引き継ぎの書き戻す範囲。SaaS 版は全ワークスペース、OSS 版は所属のないデータ。"""
    if target_mode == "oss":
        return merge.MergeSelection([], include_self_hosted=True)
    async with dbinfo.read_only(dsn) as conn:
        if "workspaces" not in await dbinfo.list_tables(conn):
            return merge.MergeSelection([])
        ids = [r["id"] for r in await conn.fetch("SELECT id FROM workspaces")]
    return merge.MergeSelection(ids)


def _jsonable(d: dict[str, object]) -> dict[str, object]:
    return {k: dbinfo.to_jsonable(k, v) for k, v in d.items()}
