"""/health エンドポイントのスモークテスト（DB未起動でも 200 を返すことを確認）。"""
import httpx
from httpx import ASGITransport

from app.config import settings
from app.main import app


async def test_health_check_returns_expected_shape() -> None:
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in ("ok", "degraded")
    assert "timestamp" in body
    assert "database" in body["services"]


async def test_cors_allows_frontend_origin() -> None:
    # frontendがブラウザからAPIを呼べることの回帰テスト（Sprint 5で欠落に気づいた）
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health", headers={"Origin": settings.frontend_url})

    assert response.headers["access-control-allow-origin"] == settings.frontend_url
