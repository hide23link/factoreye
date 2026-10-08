"""起動の入口: `uvicorn --factory recovery.main:build`"""

from fastapi import FastAPI

from recovery.app import create_app
from recovery.config import load_settings
from recovery.scratch import Scratch
from recovery.sources import make_source


def build() -> FastAPI:
    settings = load_settings()
    source = make_source(settings.backup_source, settings.cache_dir, settings.s3_endpoint_url)
    return create_app(settings, source, Scratch(settings.scratch_dsn))
