"""更新 API（PUT）の共通処理。

更新の入力は「送られた項目だけ」を変える（省略した項目は今の値のまま）。ただし、スキーマは
省略と null を同じ型（`X | None = None`）で受けるため、NOT NULL の列に null が送られても
通ってしまい、保存で失敗（500・誤った 409）したり、null が保存されて以降の取得が壊れたりした。
ここで、null を許さない項目への null は 422 にする。null を許す項目（説明・センサーの紐付け・
閾値など）は、null で消せる。
"""
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel
from pydantic.alias_generators import to_camel


def apply_update(
    obj: Any, payload: BaseModel, *, non_nullable: frozenset[str] = frozenset()
) -> None:
    """payload の「送られた項目」だけを obj に反映する。

    non_nullable: null を許さない項目の名前（モデルの属性名）。null が送られたら 422。
    obj に updated_at があれば、現在時刻にする。
    """
    changes = payload.model_dump(exclude_unset=True)
    null_fields = sorted(
        name for name, value in changes.items() if value is None and name in non_nullable
    )
    if null_fields:
        names = ", ".join(to_camel(name) for name in null_fields)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{names} must not be null",
        )
    for name, value in changes.items():
        setattr(obj, name, value)
    if hasattr(obj, "updated_at"):
        obj.updated_at = datetime.now(UTC)
