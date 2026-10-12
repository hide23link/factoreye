"""応答の共通処理。

【誰が使うか】api/ の sensors.py・alarms.py・dashboards.py・settings.py・webhooks.py・widgets.py が、
応答を返すときに呼ぶ（return json_response(モデル) のように使う）。
"""
from collections.abc import Mapping, Sequence

from fastapi import Response
from pydantic import BaseModel


def json_response(model: BaseModel, headers: Mapping[str, str] | None = None) -> Response:
    """Pydantic モデルを、1 回だけ JSON にして返す。

    FastAPI に任せると、モデルを dict にし、もう一度検証し、JSON にするため、同じ変換を 2 回行う
    （一覧の応答では CPU の大部分）。ここで直接 JSON にする。
    応答の形（camelCase の項目）は変わらない。OpenAPI の定義は、呼び出し側の response_model で残す。
    """
    return Response(
        content=model.model_dump_json(by_alias=True),
        media_type="application/json",
        headers=dict(headers or {}),
    )


def json_array_body(items: Sequence[BaseModel]) -> str:
    """モデルの配列を、1 回だけ JSON の配列の文字列にする。"""
    return "[" + ",".join(item.model_dump_json(by_alias=True) for item in items) + "]"


def json_array_response(
    items: Sequence[BaseModel], headers: Mapping[str, str] | None = None
) -> Response:
    """モデルの配列を、1 回だけ JSON の配列にして返す（json_response の配列版）。"""
    return Response(
        content=json_array_body(items), media_type="application/json", headers=dict(headers or {})
    )
