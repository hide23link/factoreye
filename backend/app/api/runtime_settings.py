"""配布版（self-hosted）の「API・取り込み」設定 API。設定ファイル（.env）を画面から見て・変える。

【呼ばれ方】画面の「設定 → API・取り込み」が呼ぶ。
- GET  /api/settings/runtime            今の設定（秘密の値は返さない）。誰でも見られる
- POST /api/settings/runtime/unlock     本文: {"password": "..."} → 30 分有効の許可証（token）を返す
- PUT  /api/settings/runtime            本文: {"values": {"INGEST_AUTH": "off"}}
                                        要・許可証。.env を書き換えて再起動する
- PUT  /api/settings/runtime/password   本文: {"password": "..."}。要・許可証。パスワードを変える
- POST /api/settings/runtime/reflect    .env を直接編集したあとの反映。パスワードは不要
許可証は、ヘッダー X-Settings-Token で送る。

【処理の流れ】変更 → 検査（app/env_file.py。起動できない内容は書かない）→ .env を書き換え →
応答を返す → 1 秒後に自分を終了 → Docker（restart: unless-stopped）が起動し直し、
新しい .env を読む。

【反映ボタンにパスワードが要らない理由】反映するのは、すでにファイルに書かれた内容だけで、
画面から新しい値を入れるわけではないため。繰り返し再起動させられないよう、
起動時から .env が書き換わっているときだけ受け付ける。
"""
import asyncio
import logging
import os
import signal
import time
from datetime import UTC, datetime, timedelta
from typing import Annotated

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import Field

from app import auth as auth_utils
from app import env_file
from app.auth import MAX_PASSWORD_BYTES
from app.config import IngestAuth, settings
from app.schemas import CamelModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings/runtime", tags=["settings"])

# 許可証（トークン）の有効時間（分）。画面を開いたままでも、この間は何度でも変更できる
UNLOCK_MINUTES = 30
TOKEN_SCOPE = "runtime-settings"
# 保存の応答を返してから、再起動のために終了するまでの秒数
RESTART_DELAY_SECONDS = 1.0
# パスワードの連続失敗の上限と、止める秒数（推測を続けられないように）
MAX_FAILED_UNLOCKS = 5
LOCKOUT_SECONDS = 60
MIN_PASSWORD_LENGTH = 6


class _FailureCounter:
    """パスワードの連続失敗を数える（メモリ上。再起動で消える）。成功したら 0 に戻す。"""

    def __init__(self) -> None:
        self.count = 0
        self.locked_until = 0.0

    def seconds_locked(self) -> int:
        return max(0, int(self.locked_until - time.monotonic()))

    def record_failure(self) -> None:
        self.count += 1
        if self.count >= MAX_FAILED_UNLOCKS:
            self.locked_until = time.monotonic() + LOCKOUT_SECONDS
            self.count = 0

    def reset(self) -> None:
        self.count = 0
        self.locked_until = 0.0


_failures = _FailureCounter()


class RuntimeSettingsRead(CamelModel):
    ingest_api_key_configured: bool
    ingest_auth: IngestAuth
    ingest_auto_create: bool
    ingest_auto_create_max_sensors: int
    ingest_device_time: bool
    ingest_rate_limit: str
    ingest_cache_seconds: float
    webhook_allow_private_networks: bool
    frontend_url: str
    # 管理パスワードが設定済みか。未設定だと、画面からは変更できない
    password_configured: bool
    # 起動したあとに .env が書き換えられている（表示は反映前の値）
    file_changed: bool


class UnlockRequest(CamelModel):
    password: Annotated[str, Field(min_length=1)]


class UnlockResponse(CamelModel):
    token: str
    expires_in_seconds: int


class RuntimeSettingsUpdate(CamelModel):
    # 変えたい項目だけ。項目名は .env と同じ（例: INGEST_AUTH）。値は文字列で送る
    values: dict[str, str] = Field(min_length=1)


class PasswordUpdate(CamelModel):
    password: Annotated[str, Field(min_length=MIN_PASSWORD_LENGTH)]


class SaveResponse(CamelModel):
    # true: バックエンドが数秒で再起動する（画面は /health が戻るのを待つ）
    restarting: bool


def _settings_read() -> RuntimeSettingsRead:
    """今動いている設定（起動時に読み込んだ値）から、画面に見せる内容を作る。鍵そのものは含めない。"""
    return RuntimeSettingsRead(
        ingest_api_key_configured=bool(settings.ingest_api_key)
        and settings.ingest_api_key != "change-this-in-production",
        ingest_auth=settings.ingest_auth,
        ingest_auto_create=settings.ingest_auto_create,
        ingest_auto_create_max_sensors=settings.ingest_auto_create_max_sensors,
        ingest_device_time=settings.ingest_device_time,
        ingest_rate_limit=settings.ingest_rate_limit,
        ingest_cache_seconds=settings.ingest_cache_seconds,
        webhook_allow_private_networks=settings.webhook_allow_private_networks,
        frontend_url=settings.frontend_url,
        password_configured=bool(settings.admin_password_hash),
        file_changed=env_file.digest_of(env_file.ENV_PATH) != env_file.LOADED_DIGEST,
    )


def schedule_restart() -> None:
    """応答を返したあとに、自分に終了の合図（SIGTERM）を送る。

    uvicorn は合図を受けると、受信バッファの最後の保存（start_and_stop の終了処理）をして終わる。
    Docker の restart: unless-stopped が、新しい .env でもう一度起動する。テストでは差し替える。
    """
    loop = asyncio.get_running_loop()
    loop.call_later(RESTART_DELAY_SECONDS, os.kill, os.getpid(), signal.SIGTERM)


def _create_token() -> str:
    expire = datetime.now(UTC) + timedelta(minutes=UNLOCK_MINUTES)
    return jwt.encode({"scp": TOKEN_SCOPE, "exp": expire}, settings.jwt_secret, algorithm="HS256")


def require_unlocked(
    x_settings_token: Annotated[str | None, Header()] = None,
) -> None:
    """変更系の API の入口。許可証（unlock で受け取った token）が正しくなければ 401。"""
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="管理パスワードの入力が必要です"
    )
    if x_settings_token is None:
        raise unauthorized
    try:
        payload = jwt.decode(x_settings_token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise unauthorized from None
    if payload.get("scp") != TOKEN_SCOPE:
        raise unauthorized


@router.get("", response_model=RuntimeSettingsRead)
async def get_runtime_settings() -> RuntimeSettingsRead:
    return _settings_read()


@router.post("/unlock", response_model=UnlockResponse)
async def unlock(body: UnlockRequest) -> UnlockResponse:
    if not settings.admin_password_hash:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "管理パスワードが未設定です。"
                "サーバーで ./factoreye.sh set-password を実行してください"
            ),
        )
    wait = _failures.seconds_locked()
    if wait > 0:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"失敗が続いたため、{wait} 秒後にやり直してください",
        )
    if not await auth_utils.verify_password_async(body.password, settings.admin_password_hash):
        _failures.record_failure()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="パスワードが違います")
    _failures.reset()
    return UnlockResponse(token=_create_token(), expires_in_seconds=UNLOCK_MINUTES * 60)


def _save(new_text: str) -> SaveResponse:
    """検査して、通れば .env に書いて再起動を予約する。通らなければ 422（何も書かない）。"""
    problems = env_file.problems_in(new_text)
    if problems:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=problems)
    env_file.write_in_place(new_text)
    schedule_restart()
    logger.warning("runtime settings saved to %s; restarting", env_file.ENV_PATH)
    return SaveResponse(restarting=True)


@router.put("", response_model=SaveResponse, dependencies=[Depends(require_unlocked)])
async def update_runtime_settings(body: RuntimeSettingsUpdate) -> SaveResponse:
    invalid = env_file.invalid_edits(body.values)
    if invalid:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=invalid)
    new_text = env_file.apply_updates(env_file.read_text(), body.values)
    return _save(new_text)


@router.put("/password", response_model=SaveResponse, dependencies=[Depends(require_unlocked)])
async def update_password(body: PasswordUpdate) -> SaveResponse:
    if len(body.password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=[f"パスワードは {MAX_PASSWORD_BYTES} バイト以内にしてください"],
        )
    hashed = await auth_utils.hash_password_async(body.password)
    line = env_file.password_hash_line(hashed)
    new_text = env_file.apply_updates(env_file.read_text(), {env_file.PASSWORD_HASH_KEY: line})
    return _save(new_text)


@router.post("/reflect", response_model=SaveResponse)
async def reflect_file() -> SaveResponse:
    """.env を直接編集したあとの反映。検査に通れば再起動する（書き換えはしない）。"""
    if env_file.digest_of(env_file.ENV_PATH) == env_file.LOADED_DIGEST:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="設定ファイルは、起動したときから変わっていません",
        )
    problems = env_file.problems_in(env_file.read_text())
    if problems:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=problems)
    schedule_restart()
    return SaveResponse(restarting=True)
