# ── Stage 1 : installation des dépendances + compilation des modules natifs ──
FROM node:20-bookworm-slim AS deps

# python3/make/g++ : fallback node-gyp si un paquet n'a pas de prebuild
# gl (headless-gl) est en optionalDependencies : skip silencieux si les headers
# OpenGL manquent — il n'est utilisé que pour le precompute, pas le serving.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.0.6 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Stage 2 : build Next.js ──────────────────────────────────────────────────
FROM deps AS builder

# Architecture immuable : aucune config baked au build.
# Le cache-only est piloté au runtime via MAPPY_FORCE_CACHE_ONLY (server-side env).
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN pnpm build

# ── Stage 3 : image de production (serving uniquement) ───────────────────────
FROM node:20-bookworm-slim AS runner

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
