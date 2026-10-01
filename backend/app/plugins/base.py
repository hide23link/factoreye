"""プラグインAPIの型定義（Canonical Interface）。

docs/factoreye-architecture.md §Plugin System 参照。
`FactorEyePlugin` は構造的部分型（Protocol）なので、プラグイン作者は
継承ではなく「同じ形」のクラスを書けば良い。ただし実装の手間を減らすため
`BasePlugin`（本モジュール下部）を用意し、通常はそれを継承すれば十分にする。
"""
from typing import Protocol, runtime_checkable

from fastapi import APIRouter
from pydantic import BaseModel


class SensorReadingEvent(BaseModel):
    sensor_id: str
    value: float
    timestamp: str


class FactorEyeWidget(BaseModel):
    id: str
    name: str
    # ダッシュボード側（React）が解決するウィジェットコンポーネント名。
    # プラグインはメタデータのみを提供し、実コンポーネントはFrontendが持つ。
    component: str


@runtime_checkable
class FactorEyePlugin(Protocol):
    # Metadata
    name: str
    version: str
    description: str

    async def on_install(self) -> None: ...
    async def on_uninstall(self) -> None: ...
    async def on_start(self) -> None: ...
    async def on_stop(self) -> None: ...

    async def on_reading(self, event: SensorReadingEvent) -> None: ...

    routes: APIRouter | None
    widgets: list[FactorEyeWidget]


class BasePlugin:
    """全フックが no-op のデフォルト実装。プラグイン作者は必要なフックだけ上書きする。"""

    name: str = ""
    version: str = "0.1.0"
    description: str = ""
    routes: APIRouter | None = None
    # クラス属性として共有されるため、サブクラスはappendで書き換えず
    # __init__ 内で self.widgets = [...] のように新しいリストを代入すること
    widgets: list[FactorEyeWidget] = []

    async def on_install(self) -> None:
        return None

    async def on_uninstall(self) -> None:
        return None

    async def on_start(self) -> None:
        return None

    async def on_stop(self) -> None:
        return None

    async def on_reading(self, event: SensorReadingEvent) -> None:
        return None
