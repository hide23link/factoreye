FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Viteの環境変数はビルド時に静的ファイルへ焼き込まれる（実行時のenvironment:は効果が無い）。
# LAN上の別ホストからアクセスする場合は、docker-compose.ymlと同じ階層の.envに
# VITE_API_URL=http://<このホストのIP>:8000 を設定してビルドし直す必要がある。
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

EXPOSE 3001

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "3001"]
