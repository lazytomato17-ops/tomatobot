# --- ビルドステージ ---
# TypeScript のコンパイルだけを行う使い捨てステージ。
FROM node:22-bookworm-slim AS build

WORKDIR /app

# 依存関係だけ先にコピーしてキャッシュを効かせる
# --ignore-scripts: package.json の prepare（husky）など、コンテナ内では不要な
# ライフサイクルスクリプトを実行しない（.git が無い環境でのエラーや失敗を防ぐため）。
# 本プロジェクトの依存パッケージは postinstall に依存していないため安全。
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# --- 実行ステージ ---
# 本番実行に必要なものだけを含む軽量イメージ。
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
    && npm cache clean --force

COPY --from=build /app/dist ./dist

# Render などの PaaS は $PORT を自動注入する（index.ts 側で process.env.PORT を参照）
EXPOSE 10000

CMD ["node", "dist/index.js"]
