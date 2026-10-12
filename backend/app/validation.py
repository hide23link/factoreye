"""入力の検証エラー（422）の応答を整える。"""
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


async def handle_input_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """422 の応答から、入力の値（input）と付帯情報（ctx）を取り除く。

    FastAPI の既定は、各エラーに送られた値をそのまま入れる。パスワードの検証に失敗すると、
    平文のパスワードが応答（画面・ログ・プロキシ）に出てしまうため、場所（loc）・種類（type）・
    利用者向けの文（msg）だけを返す。
    """
    errors = [
        {"type": err["type"], "loc": list(err["loc"]), "msg": err["msg"]} for err in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": errors})
