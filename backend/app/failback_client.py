"""復旧ツール（tools/recovery）を内部ネットワークで呼ぶクライアント。

管理画面の「書き戻し」（app/api/admin_failback.py）が使う。控え（AWS）が置いた縮小ダンプの一覧と、
今の DB に無い行だけを足す試算・実行は、復旧ツールが行う
（直前の控え・1 トランザクション・件数の再確認）。
ここは呼び出しと、失敗の分かりやすい言い換えだけを担当する。
パスワードは、ログ・例外の文に出さない。

【誰が使うか】app/api/admin_failback.py。
"""

import contextlib
from typing import Any

import httpx

from app.config import settings

# 復旧ツールの HTTP の状態コードのうち、そのまま画面に伝えるもの（ほかは 502 にする）
_STATUS_MAP = {404: 404, 409: 409, 422: 422}


class FailbackError(Exception):
    """復旧ツールの呼び出しの失敗。

    HTTP の状態コードと、画面に出す文を持つ（構造つきの詳細があれば detail）。
    """

    def __init__(self, status_code: int, message: str, detail: dict[str, Any] | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.detail = detail


# 試験で偽の相手（httpx.MockTransport）に差し替える
_transport: httpx.AsyncBaseTransport | None = None


def _client() -> httpx.AsyncClient:
    password = settings.failback_recovery_password.get_secret_value()
    if not settings.failback_recovery_url or not password:
        raise FailbackError(
            503,
            "書き戻しの設定がありません（FAILBACK_RECOVERY_URL・FAILBACK_RECOVERY_PASSWORD）",
        )
    return httpx.AsyncClient(
        base_url=settings.failback_recovery_url,
        auth=(settings.failback_recovery_username, password),
        timeout=httpx.Timeout(settings.failback_timeout_seconds, connect=5.0),
        transport=_transport,
    )


def _error_from(response: httpx.Response) -> FailbackError:
    if response.status_code == 401:
        return FailbackError(
            502,
            "復旧ツールの認証に失敗しました"
            "（FAILBACK_RECOVERY_USERNAME・FAILBACK_RECOVERY_PASSWORD を確認してください）",
        )
    detail: object = None
    with contextlib.suppress(ValueError, AttributeError):
        detail = response.json().get("detail")
    structured: dict[str, Any] | None = None
    if isinstance(detail, dict):
        structured = detail
        message = str(detail.get("message") or "")
    elif isinstance(detail, str):
        message = detail
    else:
        message = ""
    if not message:
        message = f"復旧ツールがエラーを返しました（HTTP {response.status_code}）"
    return FailbackError(_STATUS_MAP.get(response.status_code, 502), message, structured)


async def _request(method: str, path: str, json: dict[str, Any] | None = None) -> dict[str, Any]:
    async with _client() as client:
        try:
            response = await client.request(method, path, json=json)
        except httpx.TimeoutException:
            raise FailbackError(
                504, "復旧ツールの応答がありません（時間切れ）。しばらくしてから確かめてください"
            ) from None
        except httpx.HTTPError:
            raise FailbackError(
                503,
                "復旧ツールに接続できません。復旧ツール（recovery）が起動していて、"
                "同じネットワークにあるか確認してください",
            ) from None
    if response.status_code >= 400:
        raise _error_from(response)
    try:
        body = response.json()
    except ValueError:
        raise FailbackError(502, "復旧ツールの応答を読めませんでした") from None
    if not isinstance(body, dict):
        raise FailbackError(502, "復旧ツールの応答を読めませんでした")
    return body


async def r2_status() -> dict[str, Any]:
    return await _request("GET", "/api/r2restore")


async def r2_start() -> dict[str, Any]:
    """R2 の最新のベースの取得と WAL の再生を、復旧ツールの裏で始める（すぐ返る）。"""
    return await _request("POST", "/api/r2restore/start")


async def r2_reset() -> dict[str, Any]:
    """復元した作業用の DB を止めて、消す。"""
    return await _request("DELETE", "/api/r2restore")


async def run_r2_failback(
    handoff: str | None, apply: bool, expected_inserted: int | None
) -> dict[str, Any]:
    """R2 の復元（と引き継ぎ）を、1 つのトランザクションで本番に足す。試算は apply=False。"""
    body: dict[str, Any] = {"apply": apply, "handoff": handoff}
    if expected_inserted is not None:
        body["expected_inserted"] = expected_inserted
    return await _request("POST", "/api/r2restore/failback", json=body)


async def list_handoffs() -> dict[str, Any]:
    return await _request("GET", "/api/handoffs")


async def run_failback(name: str, apply: bool, expected_inserted: int | None) -> dict[str, Any]:
    """apply=False が試算（書き込まない）。True が実行（件数が試算と合うときだけ）。"""
    body: dict[str, Any] = {"apply": apply}
    if expected_inserted is not None:
        body["expected_inserted"] = expected_inserted
    # 名前は呼び出し側で形を確かめてある（パスに入れるため、URL として安全な文字だけ）
    return await _request("POST", f"/api/handoffs/{name}/failback", json=body)
