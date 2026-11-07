#!/bin/bash
# infra/cloud/deploy-pull.sh の試験。Docker も GitHub も要らない（手元の git リポジトリと、docker の代役を使う）。
# 実行: infra/tests/test-deploy-pull.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "NG: $*" >&2; exit 1; }
GIT="git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false"

# 「GitHub」の代わりの、手元の中央リポジトリ。そこから、本番のコピー（APP）を作る
git init -q --bare "$T/origin.git" -b main
git clone -q "$T/origin.git" "$T/work" 2>/dev/null
mkdir -p "$T/work/backend" "$T/work/docs" "$T/work/infra/cloud"
echo v1 > "$T/work/backend/app.py"; echo d1 > "$T/work/docs/a.md"
cp "$ROOT/infra/cloud/deploy-pull.sh" "$T/work/infra/cloud/deploy-pull.sh"
(cd "$T/work" && $GIT add -A && $GIT commit -qm v1 && git push -q origin main)
git clone -q "$T/origin.git" "$T/app" 2>/dev/null

# docker の代役: 呼ばれた引数を記録する（FAIL_DOCKER があれば失敗する）
mkdir -p "$T/bin"
cat > "$T/bin/docker" <<STUB
#!/bin/bash
echo "\$@" >> "$T/docker.log"
[ -z "\${FAIL_DOCKER:-}" ] || exit 1
STUB
chmod +x "$T/bin/docker"
run() { PATH="$T/bin:$PATH" APP_DIR="$T/app" "$T/app/infra/cloud/deploy-pull.sh"; }
push_change() { # 引数: ファイル 内容
  (cd "$T/work" && mkdir -p "$(dirname "$1")" && echo "$2" > "$1" && $GIT add -A && $GIT commit -qm "$1" && git push -q origin main)
}
deploys() { [ -f "$T/docker.log" ] && wc -l < "$T/docker.log" | tr -d ' ' || echo 0; }

# 1. 初回: 今の版をデプロイ済みとして記録するだけ（作り直さない）
run >/dev/null
[ "$(deploys)" = "0" ] || fail "初回に作り直している"
[ "$(cat "$T/app/.deployed")" = "$(git -C "$T/app" rev-parse HEAD)" ] || fail "初回の記録がない"

# 2. 変更なし: 何もしない
run >/dev/null
[ "$(deploys)" = "0" ] || fail "変更がないのに作り直している"

# 3. 文書だけの変更: コードは更新するが、作り直さない
push_change docs/a.md d2
run >/dev/null
[ "$(deploys)" = "0" ] || fail "文書だけの変更で作り直している"
[ "$(cat "$T/app/docs/a.md")" = "d2" ] || fail "コードが更新されていない"

# 4. backend だけの変更: backend だけを作り直す（DB には触れない）
push_change backend/app.py v2
run >/dev/null
[ "$(deploys)" = "1" ] || fail "backend の変更で作り直していない"
grep -q "compose -f docker-compose.cloud.yml up -d --build" "$T/docker.log" || fail "docker の呼び方が違う: $(cat "$T/docker.log")"
last() { tail -1 "$T/docker.log"; }
[ "$(last)" = "compose -f docker-compose.cloud.yml up -d --build --no-deps backend" ] || fail "backend だけを作り直していない: $(last)"

# 4b. frontend だけの変更: frontend だけを作り直す（DB には触れない）
push_change frontend/app.js f1
run >/dev/null
[ "$(last)" = "compose -f docker-compose.cloud.yml up -d --build --no-deps frontend" ] || fail "frontend だけを作り直していない: $(last)"

# 4c. backend と frontend の両方: その 2 つだけ
(cd "$T/work" && echo v2b > backend/app.py && echo f2 > frontend/app.js && $GIT add -A && $GIT commit -qm both && git push -q origin main)
run >/dev/null
[ "$(last)" = "compose -f docker-compose.cloud.yml up -d --build --no-deps backend frontend" ] || fail "2 つだけを作り直していない: $(last)"

# 4d. infra/cloud（DB のイメージなど）の変更: 全部を作り直す
push_change infra/cloud/postgres/Dockerfile p1
run >/dev/null
[ "$(last)" = "compose -f docker-compose.cloud.yml up -d --build" ] || fail "全部を作り直していない: $(last)"

# 5. 作り直しに失敗したら、記録せず、次の回にもう一度試す
push_change backend/app.py v3
FAIL_DOCKER=1 run >/dev/null 2>&1 && fail "失敗したのに成功扱い"
[ "$(cat "$T/app/.deployed")" != "$(git -C "$T/app" rev-parse origin/main)" ] || fail "失敗したのに記録している"
before="$(deploys)"
run >/dev/null
[ "$(deploys)" = "$((before + 1))" ] || fail "次の回に、もう一度試していない"
[ "$(cat "$T/app/.deployed")" = "$(git -C "$T/app" rev-parse origin/main)" ] || fail "成功したのに記録がない"

# 6. 本番のコードが手元で書き換えられていたら、上書きせずに止まる
(cd "$T/app" && echo local > backend/app.py && $GIT commit -qam "local edit")
push_change backend/other.py x
n="$(deploys)"
run >/dev/null 2>&1 && fail "食い違っているのに続行した"
[ "$(deploys)" = "$n" ] || fail "食い違っているのに作り直した"

# 7. 前回の実行が残っている（ロック中）なら、何もしない
mkdir "$T/app/.deploy.lock"
run >/dev/null || fail "ロック中は、正常終了（何もしない）のはず"
rmdir "$T/app/.deploy.lock"
echo "OK: deploy-pull.sh の試験にすべて合格"
