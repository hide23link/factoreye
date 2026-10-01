"""プラグイン発見（discovery）: app/plugins/installed/ 配下をスキャンする。

docs/factoreye-architecture.md §Phase 0 プラグイン発見メカニズム 参照。
ローカルファイルシステムのみ対象（pipによる動的インストールはPhase 0では非対応）。
"""
import importlib
import logging
from dataclasses import dataclass
from pathlib import Path

from app.plugins.base import FactorEyePlugin

logger = logging.getLogger(__name__)

_INSTALLED_PACKAGE = "app.plugins.installed"
_INSTALLED_DIR = Path(__file__).parent / "installed"


@dataclass
class DiscoveredPlugin:
    folder_name: str
    instance: FactorEyePlugin


def discover_plugins() -> list[DiscoveredPlugin]:
    """`installed/` 配下の各フォルダから `plugin` インスタンスを読み込む。

    壊れたプラグイン1つのために起動全体を失敗させない（ログに残してスキップする）。
    """
    discovered: list[DiscoveredPlugin] = []

    if not _INSTALLED_DIR.is_dir():
        return discovered

    for entry in sorted(_INSTALLED_DIR.iterdir()):
        if not entry.is_dir() or entry.name.startswith("_") or entry.name == "__pycache__":
            continue
        if not (entry / "__init__.py").exists():
            continue

        module_name = f"{_INSTALLED_PACKAGE}.{entry.name}"
        try:
            module = importlib.import_module(module_name)
            instance = module.plugin
        except Exception:
            logger.exception("プラグイン読み込み失敗: %s（スキップ）", entry.name)
            continue

        if not isinstance(instance, FactorEyePlugin):
            logger.error(
                "プラグイン %s の `plugin` が FactorEyePlugin を満たしていません（スキップ）",
                entry.name,
            )
            continue

        if instance.name != entry.name:
            logger.error(
                "プラグイン名不一致: フォルダ=%s instance.name=%s（名前はフォルダ名と要一致）",
                entry.name,
                instance.name,
            )
            continue

        discovered.append(DiscoveredPlugin(folder_name=entry.name, instance=instance))

    return discovered
