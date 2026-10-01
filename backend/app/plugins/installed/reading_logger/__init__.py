"""reading_logger: Plugin Systemの動作確認用サンプルプラグイン。

受信した Reading の件数を起動からの累計でカウントし、`/api/plugins/reading_logger/stats`
で参照できるようにする。サードパーティプラグインを書く際の最小の実装例でもある。
"""
import logging

from fastapi import APIRouter

from app.plugins.base import BasePlugin, FactorEyeWidget, SensorReadingEvent

logger = logging.getLogger(__name__)


class ReadingLoggerPlugin(BasePlugin):
    name = "reading_logger"
    version = "0.1.0"
    description = "受信したReadingの件数を記録するサンプルプラグイン（動作確認用）"

    def __init__(self) -> None:
        self.readings_seen = 0
        self.widgets: list[FactorEyeWidget] = [
            FactorEyeWidget(
                id="reading-logger-status",
                name="Reading Logger Status",
                component="PluginStatusWidget",
            )
        ]
        self.routes: APIRouter | None = APIRouter()
        self.routes.add_api_route("/stats", self._stats, methods=["GET"])

    async def _stats(self) -> dict[str, int]:
        return {"readingsSeen": self.readings_seen}

    async def on_start(self) -> None:
        self.readings_seen = 0
        logger.info("reading_logger started")

    async def on_stop(self) -> None:
        logger.info("reading_logger stopped (total readings seen: %d)", self.readings_seen)

    async def on_reading(self, event: SensorReadingEvent) -> None:
        self.readings_seen += 1


plugin = ReadingLoggerPlugin()
