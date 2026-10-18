"""環境変数から設定を読む。

どこで起動しても（本番の LXC・ラズパイ・Mac）同じイメージを使えるよう、
起動する場所ごとの違いはすべて環境変数で渡す。

【誰が使うか】app.py、main.py が読み込む。
"""

import os
from dataclasses import dataclass
from pathlib import Path

# 画面にはバックアップの中身（利用者のデータ）が出るため、短い合言葉では起動させない
MIN_PASSWORD_LENGTH = 12


TARGET_MODES = ("saas", "oss")


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    # バックアップの読み込み元。ディレクトリのパスか s3://<バケット>/<接頭辞>
    backup_source: str
    # バックアップを展開する作業用の Postgres（管理用 DB への接続）。本番の DB は指定しない
    scratch_dsn: str
    # 状態を確認する、今の DB。本番が失われた後に別のマシンで使う場合は無し
    target_dsn: str | None
    # 書き戻しに使う、今の DB への書き込みできる接続。無ければ書き戻しの機能を出さない
    target_write_dsn: str | None
    # 今の DB が SaaS 版（"saas"）か OSS 版（"oss"）か。書き戻すデータの種類を合わせるために使う
    target_mode: str | None
    # S3 から取ってきたファイルを置く場所
    cache_dir: Path
    username: str
    password: str
    s3_endpoint_url: str | None
    # 書き戻しの直前に取る、今の DB の控えの置き場所
    snapshot_dir: Path


def normalize_dsn(dsn: str) -> str:
    """FactorEye の `.env` の書き方（postgresql+asyncpg://）でも受け付ける。"""
    return dsn.replace("postgresql+asyncpg://", "postgresql://", 1)


def load_settings(env: dict[str, str] | None = None) -> Settings:
    e = dict(os.environ) if env is None else env

    password = e.get("RECOVERY_PASSWORD", "")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ConfigError(
            f"RECOVERY_PASSWORD を {MIN_PASSWORD_LENGTH} 文字以上で設定してください"
        )
    scratch = e.get("SCRATCH_DSN", "")
    if not scratch:
        raise ConfigError("SCRATCH_DSN を設定してください（コンテナでは自動で設定されます）")
    source = e.get("BACKUP_SOURCE", "")
    if not source:
        raise ConfigError("BACKUP_SOURCE（ディレクトリか s3://...）を設定してください")

    target = e.get("TARGET_DATABASE_URL") or None
    write = e.get("TARGET_WRITE_DATABASE_URL") or None
    if write and not target:
        raise ConfigError("TARGET_WRITE_DATABASE_URL には TARGET_DATABASE_URL も必要です")
    mode = e.get("TARGET_MODE", "").strip().lower() or None
    if mode not in (None, *TARGET_MODES):
        raise ConfigError("TARGET_MODE は saas か oss を設定してください")
    # データの中身からは判断しない（空の SaaS 版の DB は、OSS 版と見分けられないため）
    if write and mode is None:
        raise ConfigError(
            "書き戻しを使う場合は TARGET_MODE（今の DB が SaaS 版なら saas、OSS 版なら oss）を"
            "設定してください"
        )
    return Settings(
        backup_source=source,
        scratch_dsn=normalize_dsn(scratch),
        target_dsn=normalize_dsn(target) if target else None,
        target_write_dsn=normalize_dsn(write) if write else None,
        target_mode=mode,
        cache_dir=Path(e.get("RECOVERY_CACHE_DIR", "/var/lib/recovery/cache")),
        username=e.get("RECOVERY_USERNAME", "admin"),
        password=password,
        s3_endpoint_url=e.get("S3_ENDPOINT_URL") or None,
        snapshot_dir=Path(e.get("RECOVERY_SNAPSHOT_DIR", "/var/lib/recovery/snapshots")),
    )
