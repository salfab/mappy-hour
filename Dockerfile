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

# NEXT_PUBLIC_* doit être présent au moment de `next build` pour être
# inlined dans le bundle client. Reçu en build-arg via docker-publish.yml
# (qui lit le GitHub Secret NEXT_PUBLIC_STADIA_API_KEY).
ARG NEXT_PUBLIC_STADIA_API_KEY=""
ENV NEXT_PUBLIC_STADIA_API_KEY=$NEXT_PUBLIC_STADIA_API_KEY

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
# Scripts + src + tsconfig sont nécessaires au profil compose `atlas-loader`,
# qui lance `pnpm atlas:download` (tsx scripts/release/download-atlas.ts).
# Ils ne sont PAS chargés par le serveur Next.js (seul .next l'est) donc
# overhead négligeable côté runtime et zéro impact sur la surface d'attaque.
COPY --from=builder /app/scripts            ./scripts
COPY --from=builder /app/src                ./src
COPY --from=builder /app/tsconfig.json      ./tsconfig.json
# scripts/runtime/check-places-update.mjs and split-places-per-region.mjs
# come along with the scripts/ COPY above (used by docker-entrypoint.sh).

# Posture 4 — baked places dataset. Kept as a separate, near-the-end COPY
# so changing places.json invalidates only this layer (not the giant
# node_modules / .next layers). The CI pipeline populates these files
# from the latest `places-v*` GitHub release before `docker build`.
COPY data/processed/places/*.json ./data/processed/places/

# Entrypoint orchestrates the fail-soft places-update check, then
# `pnpm start`. ALWAYS exits 0 on update errors — never blocks startup.
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

VOLUME /data

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
