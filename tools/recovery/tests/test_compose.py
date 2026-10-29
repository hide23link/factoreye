"""docker-compose の設定が、組み合わせによらず検証を通ることの試験（docker compose config）。

group_add に同じ値が 2 つ並ぶと、docker compose が「group_add items are equal」で失敗する。
BACKUP_GID と WALG_GID の既定・片方だけ・同値の組み合わせで確かめる。
docker compose が無ければ飛ばす。
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent


def _have_compose() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


pytestmark = pytest.mark.skipif(not _have_compose(), reason="docker compose が必要")


def _config(
    tmp_path: Path, files: list[str], env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    for name in ("docker-compose.yml", "docker-compose.lxc.yml", "docker-compose.walg.yml"):
        shutil.copy(HERE / name, tmp_path / name)
    (tmp_path / ".env").write_text("RECOVERY_PASSWORD=0123456789abcdef\n")
    args = ["docker", "compose"]
    for f in files:
        args += ["-f", f]
    full_env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), **env}
    return subprocess.run(
        [*args, "config"], cwd=tmp_path, env=full_env, capture_output=True, text=True
    )


BASE = ["docker-compose.yml"]
LXC = ["docker-compose.yml", "docker-compose.lxc.yml"]
WALG = ["docker-compose.yml", "docker-compose.lxc.yml", "docker-compose.walg.yml"]


@pytest.mark.parametrize("files", [BASE, LXC], ids=["base", "lxc"])
@pytest.mark.parametrize(
    "env",
    [{}, {"BACKUP_GID": "1000"}, {"BACKUP_GID": "0"}, {"BACKUP_GID": "1000", "WALG_GID": "1000"}],
    ids=["default", "backup-gid-only", "backup-gid-zero", "same-values-ignored-without-override"],
)
def test_config_passes_without_the_walg_override(
    tmp_path: Path, files: list[str], env: dict[str, str]
) -> None:
    r = _config(tmp_path, files, env)
    assert r.returncode == 0, r.stderr


def test_config_passes_with_the_override_and_a_different_group(tmp_path: Path) -> None:
    r = _config(tmp_path, WALG, {"BACKUP_GID": "1000", "WALG_GID": "2000"})
    assert r.returncode == 0, r.stderr
    assert "1000" in r.stdout and "2000" in r.stdout


def test_override_requires_walg_gid(tmp_path: Path) -> None:
    r = _config(tmp_path, WALG, {})
    assert r.returncode != 0 and "WALG_GID" in r.stderr
