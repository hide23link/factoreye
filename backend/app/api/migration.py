"""移行API。Web の設定画面「データ移行」から使う。

- GET  /api/settings/migration/status : このサーバーで使える移行機能
- GET  /api/settings/migration/export : 書き出す。SaaS はログイン中のワークスペース、
  self-hosted は全データ（他の self-hosted サーバーへの移行・バックアップ用）
- POST /api/settings/migration/import : OSS（self-hosted）。本文（gzip）の書き出しファイルを取り込む

書き出しはどちらのモードでも使える。取り込みは self-hosted だけ有効（SaaS では 404）。
self-hosted の書き出し・取り込みは、他の書き込みAPIと同じく認証がない
（ネットワーク境界で守る前提。元々 GET /api/sensors 等でも全データが読めるため、
書き出しを足しても新たな漏えいにはならない）。

【引数】workspace_id（SaaS のとき、ログイン中のワークスペース）は、FastAPI が Depends で自動で渡す。
"""

import os
import tempfile
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sqlalchemy.exc import IntegrityError
from starlette.background import BackgroundTask

from app.api.deps import get_current_workspace_id
from app.config import AuthMode, settings
from app.db.session import engine
from app.migrate_saas_to_oss import (
    MigrationError,
    export_workspace,
    import_bundle,
    integrity_message,
)

router = APIRouter(prefix="/api/settings/migration", tags=["migration"])


def _is_saas() -> bool:
    return settings.auth_mode == AuthMode.MULTI_TENANT


def _new_temp_file() -> Path:
    fd, name = tempfile.mkstemp(suffix=".jsonl.gz")
    os.close(fd)
    return Path(name)


@router.get("/status")
async def migration_status() -> dict[str, object]:
    saas = _is_saas()
    return {
        "mode": "multi_tenant" if saas else "self_hosted",
        # 書き出しはどちらのモードでも使える。SaaS はログイン中のワークスペース、
        # self-hosted は全データが対象（§10.1）
        "canExport": True,
        "canImport": not saas,
    }


@router.get("/export")
async def export_my_workspace(
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> FileResponse:
    # SaaS はログイン必須（workspace_id が取れないと 401 は get_current_workspace_id 側で起きる）。
    # self-hosted は workspace_id が常に None で、全データを対象にする
    if _is_saas() and workspace_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    path = _new_temp_file()
    try:
        await export_workspace(engine, workspace_id, path)
    except MigrationError as error:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from None
    except BaseException:
        path.unlink(missing_ok=True)
        raise

    name = str(workspace_id) if workspace_id is not None else "self-hosted"
    return FileResponse(
        path,
        media_type="application/gzip",
        filename=f"factoreye-workspace-{name}.jsonl.gz",
        background=BackgroundTask(path.unlink, missing_ok=True),
    )


@router.post("/import")
async def import_workspace(
    request: Request,
    dry_run: Annotated[bool, Query()] = False,
    with_notifications: Annotated[bool, Query()] = False,
) -> dict[str, object]:
    if _is_saas():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    path = _new_temp_file()
    try:
        with path.open("wb") as out:
            async for chunk in request.stream():
                out.write(chunk)
        counts = await import_bundle(
            engine, path, dry_run=dry_run, with_notifications=with_notifications
        )
    except MigrationError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from None
    except IntegrityError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"取り込みを中止しました（何も残していません）: {integrity_message(error)}",
        ) from None
    finally:
        path.unlink(missing_ok=True)

    return {"dryRun": dry_run, "counts": counts}
