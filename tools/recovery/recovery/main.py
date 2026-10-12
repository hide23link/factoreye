"""起動の入口: `uvicorn --factory recovery.main:build`

【誰が・いつ呼ぶか】tools/recovery/entrypoint.sh が、コンテナの起動時に呼ぶ（引数はない）。
"""

from fastapi import FastAPI

from recovery.app import create_app
from recovery.config import load_settings
from recovery.scratch import Scratch
from recovery.sources import CompositeSource, LocalSource, make_source


def build() -> FastAPI:
    settings = load_settings()
    source = CompositeSource(
        [make_source(settings.backup_source, settings.cache_dir, settings.s3_endpoint_url)],
        # 書き戻しの直前の控えも一覧に出す（書き戻しを取り消したいときに、そこから比較・閲覧できる）
        optional=[LocalSource(settings.snapshot_dir)],
    )
    return create_app(settings, source, Scratch(settings.scratch_dsn))
