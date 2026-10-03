"""エミュレータの Web 画面と制御 API。

エンドポイント:
  GET  /                    画面
  GET  /api/status          実行状態・計測値（画面が2秒ごとに読む）
  GET  /api/scenario        現在の想定（設定値）
  PUT  /api/scenario        想定の変更（実行中なら即反映）
  POST /api/start           開始（body に想定の一部を入れると、開始前に上書き）
  POST /api/stop            停止
  POST /api/metrics/reset   計測値のリセット
  POST /api/cleanup         負荷テスト用ユーザーの削除（管理者ID/パスワードを body で渡す）

既定では 127.0.0.1 にだけ待ち受ける。ネットワークに公開しないこと（誰でも負荷をかけられてしまう）。
"""
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from emulator.runner import Runner
from emulator.scenario import PROFILES, LIMITS

STATIC_DIR = Path(__file__).parent / "static"


def create_app(runner: Runner | None = None) -> FastAPI:
    app = FastAPI(title="FactorEye 負荷テストエミュレータ", docs_url=None, redoc_url=None)
    engine = runner or Runner()
    app.state.runner = engine

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/status")
    async def status() -> dict[str, object]:
        return engine.status()

    @app.get("/api/scenario")
    async def get_scenario() -> dict[str, object]:
        return {"scenario": engine.scenario.to_dict(), "limits": LIMITS, "profiles": PROFILES}

    @app.put("/api/scenario")
    async def put_scenario(request: Request) -> dict[str, object]:
        patch = await _json_body(request)
        try:
            new = engine.scenario.with_patch(patch)
            mode = await engine.apply(new)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"mode": mode, "scenario": engine.scenario.to_dict()}

    @app.post("/api/start")
    async def start(request: Request) -> dict[str, object]:
        patch = await _json_body(request)
        if engine.state == "running":
            raise HTTPException(status_code=409, detail="すでに実行中です")
        try:
            await engine.start(engine.scenario.with_patch(patch))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return engine.status()

    @app.post("/api/stop")
    async def stop() -> dict[str, object]:
        await engine.stop()
        return engine.status()

    @app.post("/api/metrics/reset")
    async def reset_metrics() -> dict[str, object]:
        engine.metrics.reset()
        return engine.status()

    @app.post("/api/cleanup")
    async def cleanup(request: Request) -> dict[str, object]:
        if engine.state == "running":
            raise HTTPException(status_code=409, detail="実行を停止してから削除してください")
        body = await _json_body(request)
        admin_id = str(body.get("adminId", ""))
        password = str(body.get("password", ""))
        if not admin_id or not password:
            raise HTTPException(status_code=400, detail="管理者IDとパスワードを入力してください")
        try:
            deleted = await engine.cleanup_remote(
                engine.scenario.target_url, admin_id, password
            )
        except PermissionError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        return {"deleted": deleted}

    return app


async def _json_body(request: Request) -> dict[str, object]:
    if not await request.body():
        return {}
    data = await request.json()
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="JSON オブジェクトで指定してください")
    return data
