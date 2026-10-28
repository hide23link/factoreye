"""起動の入口: `uvicorn --factory recovery.main:build`

【誰が・いつ呼ぶか】tools/recovery/entrypoint.sh が、コンテナの起動時に呼ぶ（引数はない）。
"""

from fastapi import FastAPI

from recovery.app import create_app
from recovery.config import load_settings
from recovery.scratch import Scratch
from recovery.sources import CompositeSource, HandoffSource, LocalSource, make_source
from recovery.walg import R2Restore


def build() -> FastAPI:
    settings = load_settings()
    source = CompositeSource(
        [make_source(settings.backup_source, settings.cache_dir, settings.s3_endpoint_url)],
        # 書き戻しの直前の控えも一覧に出す（書き戻しを取り消したいときに、そこから比較・閲覧できる）
        optional=[LocalSource(settings.snapshot_dir)],
    )
    handoff = None
    if settings.handoff_source:
        # 控え（AWS）が置いた縮小ダンプ。鍵と S3_ENDPOINT_URL（R2）は、
        # 本来のバックアップと同じものを使う
        handoff = HandoffSource(
            make_source(settings.handoff_source, settings.cache_dir, settings.s3_endpoint_url)
        )
    r2 = R2Restore(settings.walg_env, settings.r2_work_dir) if settings.walg_env else None
    return create_app(settings, source, Scratch(settings.scratch_dsn), handoff, r2)
