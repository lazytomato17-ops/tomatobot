# --- ビルドステージ ---
# TypeScript のコンパイルだけを行う使い捨てステージ。
FROM node:20-bookworm-slim AS build

WORKDIR /app

# 依存関係だけ先にコピーしてキャッシュを効かせる
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# --- 実行ステージ ---
# 本番実行に必要なものだけを含む軽量イメージ。
FROM node:20-bookworm-slim AS runner

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --from=build /app/dist ./dist

# Render などの PaaS は $PORT を自動注入する（index.ts 側で process.env.PORT を参照）
EXPOSE 10000

CMD ["node", "dist/index.js"]
