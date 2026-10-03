"""負荷テストのシナリオ（想定の設定値）。Web画面から実行中に変更できる。

既定値は「同時 20〜50 ユーザー、センサーは 5 秒ごとに送信」の想定。
"""
from dataclasses import asdict, dataclass, fields, replace
from urllib.parse import urlparse

# 本番ホスト。ここへの実行は --allow-production を付けない限り拒否する
PRODUCTION_HOSTS = frozenset({"factoreye.hide23.link"})

PROFILES = ("sine", "random", "spiky")

# 入力の許容範囲（画面・API の両方で検証する）
LIMITS: dict[str, tuple[float, float]] = {
    "users": (1, 100),
    "sensors_per_user": (1, 10),  # 無料プランの上限（10個）に合わせる
    "send_interval_s": (0.1, 60),
    "jitter_s": (0, 5),
    "viewers_per_user": (0, 10),
    "viewer_interval_s": (0.1, 60),
    "spike_probability": (0, 1),
}


def is_production_target(target_url: str) -> bool:
    host = urlparse(target_url).hostname or ""
    return host in PRODUCTION_HOSTS


@dataclass(frozen=True)
class Scenario:
    target_url: str = "http://127.0.0.1:8000"
    users: int = 20
    sensors_per_user: int = 5
    send_interval_s: float = 5.0
    jitter_s: float = 0.5
    viewers_per_user: int = 1
    viewer_interval_s: float = 3.0
    value_profile: str = "sine"
    spike_probability: float = 0.02
    # 取り込みの平均値・振れ幅（値の生成に使う）
    value_base: float = 50.0
    value_amplitude: float = 10.0
    password: str = "loadtest-pass-1234"
    # 既存の負荷テストユーザーを区別するメールの接頭辞
    email_prefix: str = "lt"
    allow_production: bool = False

    def validate(self) -> None:
        for name, (low, high) in LIMITS.items():
            value = getattr(self, name)
            if not (low <= value <= high):
                raise ValueError(f"{name} は {low} 〜 {high} の範囲で指定してください（指定値: {value}）")
        if self.value_profile not in PROFILES:
            raise ValueError(f"value_profile は {', '.join(PROFILES)} のいずれかです")
        if self.jitter_s > self.send_interval_s:
            raise ValueError("jitter_s は send_interval_s 以下にしてください")
        if not self.target_url.startswith(("http://", "https://")):
            raise ValueError("target_url は http:// か https:// で始めてください")
        if is_production_target(self.target_url) and not self.allow_production:
            raise ValueError(
                "本番ホストへの負荷テストは拒否されています（allow_production=true が必要）"
            )
        if not self.email_prefix.isalnum() or len(self.email_prefix) > 10:
            raise ValueError("email_prefix は英数字10文字以内にしてください")

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    def with_patch(self, patch: dict[str, object]) -> "Scenario":
        """部分更新。未知のキーは拒否し、結果を検証して新しいシナリオを返す。"""
        allowed = {f.name for f in fields(self)}
        unknown = set(patch) - allowed
        if unknown:
            raise ValueError(f"未知の項目: {', '.join(sorted(unknown))}")
        new = replace(self, **_coerce(patch))
        new.validate()
        return new


_NUMERIC_INT = {"users", "sensors_per_user", "viewers_per_user"}
_NUMERIC_FLOAT = {
    "send_interval_s",
    "jitter_s",
    "viewer_interval_s",
    "spike_probability",
    "value_base",
    "value_amplitude",
}


def _coerce(patch: dict[str, object]) -> dict[str, object]:
    """Web画面からは文字列で届くことがあるため型を揃える。"""
    out: dict[str, object] = {}
    for key, raw in patch.items():
        if key in _NUMERIC_INT:
            out[key] = int(float(str(raw)))
        elif key in _NUMERIC_FLOAT:
            out[key] = float(str(raw))
        elif key == "allow_production":
            out[key] = raw in (True, "true", "1", 1)
        else:
            out[key] = str(raw) if not isinstance(raw, str) else raw
    return out
