"""応答の共通処理。"""
from fastapi import Response
from pydantic import BaseModel


def json_response(model: BaseModel) -> Response:
    """Pydantic モデルを、1 回だけ JSON にして返す。

    FastAPI に任せると、モデルを dict にし、もう一度検証し、JSON にするため、同じ変換を 2 回行う
    （一覧の応答では CPU の大部分）。ここで直接 JSON にする。
    応答の形（camelCase の項目）は変わらない。OpenAPI の定義は、呼び出し側の response_model で残す。
    """
    return Response(content=model.model_dump_json(by_alias=True), media_type="application/json")
