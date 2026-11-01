# ビルド段: TypeScript検査とViteビルドを行う（devDependenciesはこの段にだけ残る）
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Viteの環境変数はビルド時に静的ファイルへ焼き込まれる（実行時のenvironment:は効果が無い）。
# LAN上の別ホストからアクセスする場合は、docker-compose.ymlと同じ階層の.envに
# VITE_API_URL=http://<このホストのIP>:8000 を設定してビルドし直す必要がある。
ARG VITE_API_URL
ARG VITE_AUTH_MODE
# 復旧ツールの画面の URL（設定画面の「バックアップ」タブのリンク。未設定なら案内を出す）
ARG VITE_RECOVERY_URL
RUN VITE_API_URL=$VITE_API_URL VITE_AUTH_MODE=$VITE_AUTH_MODE VITE_RECOVERY_URL=$VITE_RECOVERY_URL npm run build

# 実行段: 静的ファイルをnginxで配信する（Node.jsとnode_modulesは含めない）
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 3001
