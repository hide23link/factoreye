"""プラグインのライフサイクル管理: discover → install → start/stop → on_reading dispatch。

docs/factoreye-architecture.md §Plugin System ライフサイクル 参照。

既知のリスク（Phase 0 で許容）: サンドボックスなし。on_reading 等のフック例外は
ログに残しつつ握りつぶし、1プラグインの不具合でIngestパイプライン全体を
止めないことを優先する（本ファイル内の try/except がその境界）。

ドキュメントとモデルの食い違いの解決: docs/factoreye-architecture.md のライフサイクル図は
新規プラグインを `enabled=true` で挿入すると書いているが、`app/db/models.py` の
`Plugin.enabled` はデフォルト `False`。サンドボックスがない以上、未知のプラグインを
勝手に有効化するのは安全側ではないため、本実装はモデルのデフォルト（enabled=False、
要 `PATCH /api/plugins/{name}/enable`）を正とする。
"""
import logging
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Plugin
from app.db.session import get_session
from app.plugins.base import FactorEyePlugin, FactorEyeWidget, SensorReadingEvent
from app.plugins.registry import discover_plugins

logger = logging.getLogger(__name__)


@dataclass
class LoadedPlugin:
    instance: FactorEyePlugin
    started: bool = False
    routes_mounted: bool = False


_loaded: dict[str, LoadedPlugin] = {}


def _reset_registry_for_tests() -> None:
    """テスト専用: モジュールレベルのランタイム状態をクリアする。"""
    _loaded.clear()


async def _get_or_create_row(
    session: AsyncSession, name: str, instance: FactorEyePlugin
) -> Plugin:
    result = await session.exec(select(Plugin).where(Plugin.name == name))
    row = result.first()
    if row is None:
        row = Plugin(name=name, version=instance.version, enabled=False, config={})
        session.add(row)
        await session.commit()
        await session.refresh(row)
        try:
            await instance.on_install()
        except Exception:
            logger.exception("プラグイン on_install 失敗: %s", name)
        return row

    if row.version != instance.version:
        row.version = instance.version
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


def _require_plugin_enabled(name: str) -> Callable[..., Coroutine[Any, Any, None]]:
    """disable中はプラグイン自身のHTTPルートも403で塞ぐ。

    on_reading の dispatch を止めるだけでは、disableしたつもりでもプラグイン自身の
    カスタムルートは生き続けてしまう（QAレビューで指摘された既知の制限への対応）。
    """

    async def _dependency(session: AsyncSession = Depends(get_session)) -> None:
        result = await session.exec(select(Plugin).where(Plugin.name == name))
        row = result.first()
        if row is None or not row.enabled:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="plugin disabled")

    return _dependency


def _mount_routes(app: FastAPI, name: str, loaded_plugin: LoadedPlugin) -> None:
    if loaded_plugin.routes_mounted:
        return
    if loaded_plugin.instance.routes is not None:
        app.include_router(
            loaded_plugin.instance.routes,
            prefix=f"/api/plugins/{name}",
            dependencies=[Depends(_require_plugin_enabled(name))],
        )
    # ルートが無いプラグインも「マウント試行済み」として扱い、include_router の二重呼び出しを防ぐ
    loaded_plugin.routes_mounted = True


async def load_plugins(app: FastAPI, session: AsyncSession) -> None:
    """起動時に一度だけ呼ぶ: discover → DB行をupsert → enabled分をstart。"""
    for discovered in discover_plugins():
        name = discovered.folder_name
        instance = discovered.instance
        row = await _get_or_create_row(session, name, instance)

        # load_plugins は冪等にする（同じインスタンスに対し複数回呼ばれても
        # ルートを二重マウントしない／on_startを二重実行しない）。
        loaded_plugin = _loaded.setdefault(name, LoadedPlugin(instance=instance))
        # routesはenabled状態に関わらず一度だけinclude_routerする（FastAPIはルート登録後の
        # 動的な取り消しをサポートしないため）。実際のアクセス制御は _require_plugin_enabled
        # の依存関係がリクエスト毎にDBを見て行う（disable中は403）。
        _mount_routes(app, name, loaded_plugin)

        if row.enabled:
            await _start(name, loaded_plugin)


async def _start(name: str, loaded_plugin: LoadedPlugin) -> None:
    if loaded_plugin.started:
        return
    try:
        await loaded_plugin.instance.on_start()
        loaded_plugin.started = True
    except Exception:
        logger.exception("プラグイン on_start 失敗: %s", name)


async def _stop(name: str, loaded_plugin: LoadedPlugin) -> None:
    if not loaded_plugin.started:
        return
    try:
        await loaded_plugin.instance.on_stop()
    except Exception:
        logger.exception("プラグイン on_stop 失敗: %s", name)
    finally:
        loaded_plugin.started = False


async def enable_plugin(app: FastAPI, session: AsyncSession, name: str) -> Plugin:
    row = await _get_row_or_404(session, name)
    row.enabled = True
    session.add(row)
    await session.commit()
    await session.refresh(row)

    loaded_plugin = _loaded.get(name)
    if loaded_plugin is not None:
        _mount_routes(app, name, loaded_plugin)
        await _start(name, loaded_plugin)
    return row


async def disable_plugin(session: AsyncSession, name: str) -> Plugin:
    row = await _get_row_or_404(session, name)
    row.enabled = False
    session.add(row)
    await session.commit()
    await session.refresh(row)

    loaded_plugin = _loaded.get(name)
    if loaded_plugin is not None:
        await _stop(name, loaded_plugin)
    return row


async def update_plugin_config(
    session: AsyncSession, name: str, config: dict[str, object]
) -> Plugin:
    row = await _get_row_or_404(session, name)
    row.config = config
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def _get_row_or_404(session: AsyncSession, name: str) -> Plugin:
    result = await session.exec(select(Plugin).where(Plugin.name == name))
    row = result.first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="plugin not found")
    return row


async def dispatch_reading(event: SensorReadingEvent) -> None:
    """Ingestバッファのflush後、started中の全プラグインにReading発生を通知する。"""
    for name, loaded_plugin in _loaded.items():
        if not loaded_plugin.started:
            continue
        try:
            await loaded_plugin.instance.on_reading(event)
        except Exception:
            logger.exception("プラグイン on_reading 失敗: %s（他プラグインの処理は継続）", name)


def list_active_widgets() -> list[FactorEyeWidget]:
    widgets: list[FactorEyeWidget] = []
    for loaded_plugin in _loaded.values():
        if loaded_plugin.started:
            widgets.extend(loaded_plugin.instance.widgets)
    return widgets
