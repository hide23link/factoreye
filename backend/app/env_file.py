"""設定ファイル（.env）の読み書きと検査。配布版（install/）の「画面から .env を変える」を支える。

【誰が使うか】api/runtime_settings.py が、画面の保存・反映のたびに呼ぶ。
【処理の流れ】
  読む（read_text）→ 書き換える（apply_updates）→ 検査する（problems_in）→ 書く（write_in_place）
  検査は、再起動のあとに読み込まれる設定と同じ手順（Settings）で行う。誤った .env を書いて、
  backend が起動できなくなるのを防ぐため、検査に通らない内容は、書かない・反映しない。

【ホストでの直接編集との両立】.env は、ファイル 1 つではなく、ディレクトリごとマウントしている。
  ファイル 1 つのマウントは、ホストのエディタが「新しいファイルに置き換える」保存
  （vim・sed -i など）をすると、コンテナが古い実体を見続けて、反映が効かなくなる。
  ディレクトリなら、毎回名前で開き直すので、どの編集方法でも見える。
  こちらからの書き込みは、ホスト側の所有者・権限を変えないよう、同じファイルの中身を書き換える。
"""
import hashlib
import io
import os
import re
import tempfile
from pathlib import Path

from dotenv import dotenv_values
from pydantic import ValidationError
from pydantic_core import ErrorDetails

from app.config import Settings

# 設定ファイルの場所（app/config.py と同じ決め方）。配布版は /app/config/.env で、
# docker-compose が、ホストの ./config ディレクトリをマウントしている。
# 画面で保存する直前の内容は、同じディレクトリの .env.bak に残す
ENV_PATH = Path(os.environ.get("FACTOREYE_ENV_FILE", ".env"))
BACKUP_PATH = ENV_PATH.with_name(ENV_PATH.name + ".bak")

# 設定ファイルに書くとき、そのまま（引用符なし）で安全な値の形。
# docker compose は .env の $ を変数として展開し、# 以降をコメントとみなす。
# そのため、これらを含む値は受け付けない
_BOOL = r"true|false"
EDITABLE_KEYS: dict[str, str] = {
    "INGEST_API_KEY": r"[A-Za-z0-9._-]{16,128}",
    "INGEST_AUTH": r"key|off",
    "INGEST_AUTO_CREATE": _BOOL,
    "INGEST_AUTO_CREATE_MAX_SENSORS": r"[0-9]{1,5}",
    "INGEST_DEVICE_TIME": _BOOL,
    "INGEST_RATE_LIMIT": r"off|[0-9]{1,6}/(second|minute|hour|day)",
    "INGEST_CACHE_SECONDS": r"[0-9]{1,3}(\.[0-9])?",
    "WEBHOOK_ALLOW_PRIVATE_NETWORKS": _BOOL,
    "FRONTEND_URL": r"https?://[A-Za-z0-9.:\[\]-]+(/[A-Za-z0-9._~/-]*)?",
}

PASSWORD_HASH_KEY = "ADMIN_PASSWORD_HASH"


def digest_of(path: Path) -> str:
    """ファイルの中身の指紋（SHA-256）。無ければ空文字。「起動後に書き換えられたか」の判定に使う。"""
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return ""


def read_text() -> str:
    return ENV_PATH.read_text(encoding="utf-8")


def values_in(text: str) -> dict[str, str]:
    """ファイルの内容から「項目名 → 値」を取り出す（コメントと引用符は除く）。"""
    parsed = dotenv_values(stream=io.StringIO(text))
    return {key: value for key, value in parsed.items() if value is not None}


def invalid_edits(updates: dict[str, str]) -> list[str]:
    """画面から変えてよい項目と、値の形を確かめる。問題の説明を返す（空なら問題なし）。"""
    messages: list[str] = []
    for key, value in updates.items():
        pattern = EDITABLE_KEYS.get(key)
        if pattern is None:
            messages.append(f"{key}: この画面では変更できない項目です")
        elif re.fullmatch(pattern, value) is None:
            messages.append(f"{key}: 値の形が正しくありません")
    return messages


def apply_updates(text: str, updates: dict[str, str]) -> str:
    """設定ファイルの文章の、指定した項目の行だけを書き換えて返す（コメント・順序・他の行はそのまま）。

    項目の行が無ければ、末尾に足す。呼ぶ前に、値の形は invalid_edits で確かめておくこと。
    """
    remaining = dict(updates)
    lines: list[str] = []
    for line in text.splitlines():
        key = line.split("=", 1)[0]
        if "=" in line and not line.lstrip().startswith("#") and key in remaining:
            lines.append(f"{key}={remaining.pop(key)}")
        else:
            lines.append(line)
    lines.extend(f"{key}={value}" for key, value in remaining.items())
    return "\n".join(lines) + "\n"


def password_hash_line(hashed: str) -> str:
    """ADMIN_PASSWORD_HASH に書く値。$ を含むので、単一引用符で囲む（compose の展開を避ける）。"""
    return f"'{hashed}'"


def problems_in(text: str) -> list[str]:
    """この内容で backend が起動できるかを、再起動のときと同じ手順で確かめる。

    問題の説明を返す（空なら起動できる）。値そのもの（鍵など）は説明に含めない。
    """
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".env", delete=False) as handle:
        handle.write(text)
        candidate = handle.name
    try:
        Settings(_env_file=candidate)
    except ValidationError as error:
        return [_describe(item) for item in error.errors()]
    finally:
        os.unlink(candidate)
    return []


def _describe(item: ErrorDetails) -> str:
    location = ".".join(str(part) for part in item["loc"]).upper()
    message = str(item["msg"]).removeprefix("Value error, ")
    return f"{location}: {message}" if location else message


def write_in_place(text: str) -> None:
    """直前の内容を .env.bak に残してから、.env の中身を書き換える（ファイルの実体は変えない）。"""
    previous = ENV_PATH.read_text(encoding="utf-8")
    _overwrite(BACKUP_PATH, previous)
    _overwrite(ENV_PATH, text)


def _overwrite(path: Path, text: str) -> None:
    # 無ければ作り、あれば中身だけ置き換える。秘密の値を含むので、新規作成は本人だけ読める権限にする
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())


# 起動したときの設定ファイルの指紋。あとで書き換えたか（画面の「反映前」表示）の判定に使う
LOADED_DIGEST = digest_of(ENV_PATH)