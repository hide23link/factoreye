"""汎用Webhook通知（Phase 1: ノーコード連携用）。

app.notifications.send_alarm_discordはDiscord専用の固定フォーマットだが、こちらは
任意のURLへ素のJSONをPOSTするだけの汎用版。Zapier/Make/n8n等のノーコード自動化
サービスに繋ぐことを想定しており、利用者はコードを一切書かずに外部連携できる
（docs/factoreye-architecture.md §Webhook通知 参照）。
"""
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


async def send_webhook(url: str, payload: dict[str, Any]) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
    except Exception:
        # 通知失敗でingest/flushパイプラインを落とさない（send_alarm_discordと同方針）
        logger.exception("failed to send webhook to %s", url)
