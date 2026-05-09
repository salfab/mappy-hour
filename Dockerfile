# ── Stage 1 : installation des dépendances + compilation des modules natifs ──
FROM node:20-bookworm-slim AS deps

# Outils de build pour node-gyp (gl, @mongodb-js/zstd)
# libgl-dev + libegl-dev : headers pour headless-gl (precompute GPU)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    libgl-dev libegl-dev libgles2-dev \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.0.6 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Stage 2 : build Next.js ──────────────────────────────────────────────────
FROM deps AS builder

# NEXT_PUBLIC_* vars sont inlinées à la compilation dans le bundle client.
# Passer --build-arg NEXT_PUBLIC_FORCE_CACHE_ONLY=true pour l'image de production.
ARG NEXT_PUBLIC_FORCE_CACHE_ONLY=true
ENV NEXT_PUBLIC_FORCE_CACHE_ONLY=$NEXT_PUBLIC_FORCE_CACHE_ONLY
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN pnpm build

# ── Stage 3 : image de production (serving uniquement) ───────────────────────
FROM node:20-bookworm-slim AS runner

# libgl1 : runtime headless-gl (non utilisé pour le serving, mais présent dans node_modules)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.0.6 --activate

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Chemin atlas dans le conteneur — monter un volume ici avec les atlas téléchargés
ENV MAPPY_DATA_ROOT=/data

WORKDIR /app

COPY --from=builder /app/.next              ./.next
COPY --from=builder /app/node_modules       ./node_modules
COPY --from=builder /app/package.json       ./package.json
COPY --from=builder /app/public             ./public

VOLUME /data

EXPOSE 3000

CMD ["pnpm", "start"]
