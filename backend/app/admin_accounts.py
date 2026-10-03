"""管理者アカウントの保管（DBではなくローカルのテキストファイル）。

ファイル形式（1行1件、`#` で始まる行と空行は無視）:
    <ID>:<bcryptハッシュ>

- 平文のパスワードはファイルに書かない。作成・変更は `python -m app.admin_cli` で行う
- ファイルは都度読み直すため、編集した内容は再起動なしで次のリクエストから反映される
- 管理者はDBのユーザーとは別物（管理者画面のログインはこのファイルだけで判定する）
"""

import logging
import os
import re
from pathlib import Path

from app import auth as auth_utils
from app.config import settings

_logger = logging.getLogger(__name__)

# ID は英数字と . _ - のみ（コロンを含めない＝区切り文字と衝突させない）
_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,50}$")

_HEADER = (
    "# FactorEye 管理者アカウント（1行1件: <ID>:<bcryptハッシュ>）\n"
    "# 追加・パスワード変更: python -m app.admin_cli set-admin <ID>\n"
    "# 削除: python -m app.admin_cli remove-admin <ID>\n"
    "# このファイルは Git にコミットしないこと（.gitignore 済み）\n"
)
_HEADER_LINES = tuple(_HEADER.splitlines())


def is_valid_admin_id(admin_id: str) -> bool:
    return _ID_PATTERN.fullmatch(admin_id) is not None


def _path() -> Path:
    return Path(settings.admin_credentials_file)


def _read_lines() -> list[str]:
    path = _path()
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8").splitlines()


def _parse(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or ":" not in stripped:
        return None
    admin_id, _, password_hash = stripped.partition(":")
    admin_id = admin_id.strip()
    password_hash = password_hash.strip()
    if not is_valid_admin_id(admin_id) or not password_hash:
        _logger.warning("admin accounts: ignoring malformed line for id=%r", admin_id)
        return None
    return admin_id, password_hash


def load_admins() -> dict[str, str]:
    """ID → bcryptハッシュ の辞書を返す。ファイルが無ければ空。"""
    accounts: dict[str, str] = {}
    for line in _read_lines():
        parsed = _parse(line)
        if parsed is not None:
            accounts[parsed[0]] = parsed[1]
    return accounts


def admin_exists(admin_id: str) -> bool:
    return admin_id in load_admins()


def verify_admin(admin_id: str, password: str) -> bool:
    """ID とパスワードを検証する。存在しないIDでもbcryptを走らせ、応答時間で存在を推測させない。"""
    accounts = load_admins()
    stored = accounts.get(admin_id)
    if stored is None:
        auth_utils.verify_password(password, _DUMMY_HASH)
        return False
    return auth_utils.verify_password(password, stored)


def list_admin_ids() -> list[str]:
    return sorted(load_admins())


def set_admin(admin_id: str, plain_password: str) -> None:
    """管理者を追加、または既存のパスワードを変更する。平文は保存せずハッシュだけを書く。"""
    if not is_valid_admin_id(admin_id):
        raise ValueError("ID は英数字と . _ - のみ（1〜50文字）")
    new_line = f"{admin_id}:{auth_utils.hash_password(plain_password)}"

    lines = _read_lines()
    replaced = False
    out: list[str] = []
    for line in lines:
        parsed = _parse(line)
        if parsed is not None and parsed[0] == admin_id:
            out.append(new_line)
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(new_line)
    _write(out)


def remove_admin(admin_id: str) -> bool:
    """管理者を削除する。存在しなければ False。"""
    lines = _read_lines()
    out: list[str] = []
    removed = False
    for line in lines:
        parsed = _parse(line)
        if parsed is not None and parsed[0] == admin_id:
            removed = True
            continue
        out.append(line)
    if removed:
        _write(out)
    return removed


def _write(body_lines: list[str]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # 既存のヘッダーは除いてから付け直す（書き込みのたびに重複させない）。
    # 利用者が足したコメントは残す
    kept = [ln for ln in body_lines if ln.strip() and ln not in _HEADER_LINES]
    content = _HEADER + "\n".join(kept) + "\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.chmod(tmp, 0o600)  # ハッシュ入りなので所有者のみ読み書き可
    os.replace(tmp, path)


# bcryptの時間差を作るためのダミーハッシュ（存在しないIDのログイン時に使う）
_DUMMY_HASH = auth_utils.hash_password("dummy-password-for-timing")
