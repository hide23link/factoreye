"""管理者 API: 控え（AWS）が稼いだデータを、本番に書き戻す（multi_tenant 時のみ）。

本番が止まっている間、AWS の控えが動き、増加分の縮小ダンプを R2 に置く。本番に復帰したら、
その増加分のうち**本番に無い行だけ**を足す。今ある行は変えない・消さない。
何度実行しても二重にならない。実際の書き込みは復旧ツール（tools/recovery）が行い、
ここは管理者の認証・入力の検証・呼び出しを担当する。

エンドポイント:
  GET  /api/admin/failback/handoffs   → 引き継ぎ（縮小ダンプ）の一覧
  POST /api/admin/failback/preview    → 試算（追加される件数。何も書かない）
  POST /api/admin/failback/apply      → 実行（試算の件数と一致したときだけ。
                                         直前の控えを取り、1 トランザクション）
  GET/POST/DELETE /api/admin/failback/r2   → R2 の WAL-G のバックアップの復元の状態／開始／破棄
  POST /api/admin/failback/r2/{preview,apply} → R2（＋引き継ぎ）からの試算／実行

制限: 控えの稼働中の、既存の行の更新・削除（パスワード変更など）は戻らない。
すべて require_admin（管理者トークン）で守る。
AUTH_MODE が multi_tenant 以外では、main.py がマウントしない。
"""

import logging
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app import failback_client
from app.api.deps import require_admin
from app.schemas import CamelModel

router = APIRouter(prefix="/api/admin/failback", tags=["admin"])
_logger = logging.getLogger(__name__)

# 復旧ツールの画面での名前（handoff-factoreye-<UTC日時>.sql.gz）。URL のパスに入るため形を厳しく縛る
_NAME_PATTERN = r"^handoff-factoreye-\d{8}-\d{6}\.sql\.gz$"


class HandoffItem(CamelModel):
    name: str
    size: int
    modified: datetime
    # 最新の 1 つだけ、控えの記録（latest.json）が付く。古いものは None
    kind: str | None = None
    watermark: str | None = None
    alembic: str | None = None
    instance: str | None = None
    region: str | None = None
    created_at: str | None = None


class HandoffList(CamelModel):
    source: str
    items: list[HandoffItem]


class FailbackPreviewRequest(CamelModel):
    name: str = Field(pattern=_NAME_PATTERN)


class FailbackApplyRequest(FailbackPreviewRequest):
    # 試算で確認した、足す行の合計。実行の直前にもう一度数えて、違えば実行しない
    expected_inserted: int = Field(ge=0)


class FailbackTable(CamelModel):
    table: str
    # 引き継ぎの対象の行数／本番に足す（足した）行数／本番に既にあるため飛ばした行数
    source: int
    inserted: int
    existing: int
    note: str | None = None
    closed: int = 0


class FailbackPart(CamelModel):
    """複数の元（R2 の復元・引き継ぎ）を合わせるときの、元ごとの表の件数。"""

    tables: list[FailbackTable]


class R2Info(CamelModel):
    base_name: str | None = None
    base_time: str | None = None
    wal_last_time: str | None = None
    alembic: str | None = None
    latest_reading: str | None = None


class R2Status(CamelModel):
    configured: bool
    # idle / fetching（ベースを取得中）/ replaying（WAL を再生中）/ ready / failed
    state: str
    message: str | None = None
    info: R2Info | None = None


class R2PreviewRequest(CamelModel):
    # 合わせて合流する引き継ぎ（省略すると R2 の復元だけ）
    handoff: str | None = Field(default=None, pattern=_NAME_PATTERN)


class R2ApplyRequest(R2PreviewRequest):
    expected_inserted: int = Field(ge=0)


class FailbackResult(CamelModel):
    name: str
    applied: bool
    total_inserted: int
    tables: list[FailbackTable]
    # 実行したときの、直前の本番の控え（before-merge-*.sql.gz）。試算では None
    snapshot: str | None = None
    # 元が 2 つ以上のとき（R2 ＋ 引き継ぎ）だけ。tables は合計
    parts: list[FailbackPart] = []
    # R2 の復元のときの、バックアップの内容
    r2: R2Info | None = None


def _raise(error: failback_client.FailbackError) -> HTTPException:
    # 構造つきの詳細（スキーマの版の違いなど）はそのまま、なければ文だけを返す
    detail: Any = error.detail if error.detail is not None else error.message
    return HTTPException(status_code=error.status_code, detail=detail)


def _result(name: str, body: dict[str, Any]) -> FailbackResult:
    tables = [FailbackTable.model_validate(t) for t in body.get("tables", [])]
    return FailbackResult(
        name=name,
        applied=bool(body.get("applied")),
        total_inserted=sum(t.inserted for t in tables),
        tables=tables,
        snapshot=body.get("snapshot"),
        parts=[FailbackPart.model_validate(p) for p in body.get("parts", [])],
        r2=R2Info.model_validate(body["r2"]) if body.get("r2") else None,
    )


@router.get("/handoffs", response_model=HandoffList)
async def list_handoffs(_admin_id: Annotated[str, Depends(require_admin)]) -> HandoffList:
    try:
        body = await failback_client.list_handoffs()
    except failback_client.FailbackError as e:
        raise _raise(e) from None
    return HandoffList.model_validate(
        {"source": body.get("source", ""), "items": body.get("items", [])}
    )


@router.post("/preview", response_model=FailbackResult)
async def preview(
    body: FailbackPreviewRequest, _admin_id: Annotated[str, Depends(require_admin)]
) -> FailbackResult:
    """試算。本番には何も書かない（復旧ツールが最後に取り消す）。"""
    try:
        result = await failback_client.run_failback(body.name, apply=False, expected_inserted=None)
    except failback_client.FailbackError as e:
        raise _raise(e) from None
    return _result(body.name, result)


@router.post("/apply", response_model=FailbackResult)
async def apply(
    body: FailbackApplyRequest, admin_id: Annotated[str, Depends(require_admin)]
) -> FailbackResult:
    """実行。本番に無い行だけを足す。件数が試算と違えば、復旧ツールが中止する（409）。"""
    _logger.warning("admin %s started failback of %s", admin_id, body.name)
    try:
        result = await failback_client.run_failback(
            body.name, apply=True, expected_inserted=body.expected_inserted
        )
    except failback_client.FailbackError as e:
        _logger.warning("admin %s failback of %s failed: %s", admin_id, body.name, e.message)
        raise _raise(e) from None
    out = _result(body.name, result)
    _logger.warning(
        "admin %s finished failback of %s: inserted %d rows (snapshot %s)",
        admin_id, body.name, out.total_inserted, out.snapshot,
    )
    return out


# ── R2 の WAL-G のバックアップからの復旧（本番が消えた・データが不完全なとき） ──────────────
# 時間のかかる復元（ベースの取得・WAL の再生）は、復旧ツールが裏で進める。ここでは状態を見るだけ。
# 試算・実行は、復元が終わってから（ready）。本番の DB が空（スキーマだけ）でも、一部だけでもよい。


def _r2_status(body: dict[str, Any]) -> R2Status:
    return R2Status.model_validate(body)


@router.get("/r2", response_model=R2Status)
async def r2_status(_admin_id: Annotated[str, Depends(require_admin)]) -> R2Status:
    try:
        return _r2_status(await failback_client.r2_status())
    except failback_client.FailbackError as e:
        raise _raise(e) from None


@router.post("/r2/start", response_model=R2Status)
async def r2_start(admin_id: Annotated[str, Depends(require_admin)]) -> R2Status:
    """R2 の最新のベースを取り、WAL を最新まで再生する（裏で進む）。"""
    _logger.warning("admin %s started the R2 restore", admin_id)
    try:
        return _r2_status(await failback_client.r2_start())
    except failback_client.FailbackError as e:
        raise _raise(e) from None


@router.delete("/r2", response_model=R2Status)
async def r2_reset(admin_id: Annotated[str, Depends(require_admin)]) -> R2Status:
    """復元した作業用の DB を消す（本番には触れない）。"""
    _logger.warning("admin %s discarded the R2 restore", admin_id)
    try:
        return _r2_status(await failback_client.r2_reset())
    except failback_client.FailbackError as e:
        raise _raise(e) from None


@router.post("/r2/preview", response_model=FailbackResult)
async def r2_preview(
    body: R2PreviewRequest, _admin_id: Annotated[str, Depends(require_admin)]
) -> FailbackResult:
    """試算。本番には何も書かない。"""
    try:
        result = await failback_client.run_r2_failback(body.handoff, False, None)
    except failback_client.FailbackError as e:
        raise _raise(e) from None
    return _result("r2", result)


@router.post("/r2/apply", response_model=FailbackResult)
async def r2_apply(
    body: R2ApplyRequest, admin_id: Annotated[str, Depends(require_admin)]
) -> FailbackResult:
    """実行。R2 の復元（と引き継ぎ）の、本番に無い行だけを足す。件数が試算と違えば中止（409）。"""
    _logger.warning("admin %s started failback from R2 (handoff %s)", admin_id, body.handoff)
    try:
        result = await failback_client.run_r2_failback(
            body.handoff, True, body.expected_inserted
        )
    except failback_client.FailbackError as e:
        _logger.warning("admin %s failback from R2 failed: %s", admin_id, e.message)
        raise _raise(e) from None
    out = _result("r2", result)
    _logger.warning(
        "admin %s finished failback from R2: inserted %d rows (snapshot %s)",
        admin_id, out.total_inserted, out.snapshot,
    )
    return out
