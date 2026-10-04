"""ヘッドレス操作: 画面と同じ API を順に叩き、一定時間ごとに計測結果を表示する。

例（emulator コンテナ内で実行）:
    python -m tools.drive --users 20 --sensors 5 --interval 5 --duration 60
    python -m tools.drive --set users=50 --duration 60      # 実行中に同時ユーザー数を変更
"""
import argparse
import json
import time

import httpx


def _patch_from_args(args: argparse.Namespace) -> dict[str, object]:
    patch: dict[str, object] = {"target_url": args.target, "allow_production": args.allow_production}
    for key, value in [
        ("users", args.users),
        ("sensors_per_user", args.sensors),
        ("send_interval_s", args.interval),
        ("viewers_per_user", args.viewers),
        ("value_profile", args.profile),
    ]:
        if value is not None:
            patch[key] = value
    return patch


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--emulator", default="http://127.0.0.1:8100")
    p.add_argument("--target", default="http://127.0.0.1:8000")
    p.add_argument("--users", type=int)
    p.add_argument("--sensors", type=int)
    p.add_argument("--interval", type=float)
    p.add_argument("--viewers", type=int)
    p.add_argument("--profile", choices=["sine", "random", "spiky"])
    p.add_argument("--duration", type=int, default=60)
    p.add_argument("--allow-production", action="store_true",
                   help="本番ホストへの実行を明示的に許可する")
    p.add_argument("--report-every", type=int, default=10)
    p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                   help="実行中に変更する項目（例: users=50）。--set-at 秒後に適用")
    p.add_argument("--set-at", type=int, default=30)
    args = p.parse_args()

    api = httpx.Client(base_url=args.emulator, timeout=20)
    api.post("/api/stop")
    api.put("/api/scenario", json=_patch_from_args(args)).raise_for_status()
    started = api.post("/api/start", json={})
    if started.status_code != 200:
        raise SystemExit(f"start failed: {started.status_code} {started.text}")
    print("started", json.dumps(started.json()["users"]))

    t0 = time.monotonic()
    changed = False
    while time.monotonic() - t0 < args.duration:
        time.sleep(args.report_every)
        if args.set and not changed and time.monotonic() - t0 >= args.set_at:
            patch = dict(kv.split("=", 1) for kv in args.set)
            r = api.put("/api/scenario", json=patch)
            print(f"[{int(time.monotonic()-t0)}s] change {patch} -> {r.json().get('mode')}")
            changed = True
        s = api.get("/api/status").json()
        m = s["metrics"]
        ing = m["endpoints"].get("ingest", {})
        print(
            f"[{int(time.monotonic()-t0)}s] state={s['state']} "
            f"users={s['users']['running']}/{s['users']['target']} sensors={s['users']['sensors']} "
            f"rps={m['rps']} total={m['total']} errors={m['errors']} ({m['errorRate']*100:.2f}%) "
            f"ingest_p95={ing.get('p95Ms')}ms"
        )

    final = api.get("/api/status").json()
    api.post("/api/stop")
    print("FINAL", json.dumps(final["metrics"]["endpoints"], ensure_ascii=False, indent=1))
    print("FINAL total", final["metrics"]["total"], "errors", final["metrics"]["errors"])


if __name__ == "__main__":
    main()
