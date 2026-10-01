"""共通API依存関係（認証）。DBセッションは app.db.session.get_session を参照。"""
from fastapi import Header, HTTPException, status

from app.config import settings


async def verify_ingest_api_key(x_api_key: str = Header(...)) -> None:
    """Self-hosted: .env の共有シークレット（INGEST_API_KEY）と比較。

    SaaS向けのワークスペース別write鍵（Phase 0.5）は対象外。
    """
    if x_api_key != settings.ingest_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid API key")
