#!/bin/sh
# Posture 4 — Baked image + fail-soft startup check.
#
# 1. Copy the baked places dataset from the immutable image layer
#    (/app/data/processed/places/) into the tmpfs mount
#    (/data/processed/places/). The tmpfs is required because the
#    container's rootfs is read_only.
# 2. Run the resilient places-update check (5s hard timeout, always
#    exits 0). This is a fast path for places-publish → Mitch
#    propagation without waiting for the next image rebuild.
# 3. Hand off to the regular Next.js CMD.
#
# Image-as-source-of-truth remains the strict baseline; the runtime
# check NEVER blocks startup. Any failure mode → warn → continue.
set -e

PLACES_BAKED_DIR="/app/data/processed/places"
PLACES_RUNTIME_DIR="/data/processed/places"

if [ -d "$PLACES_BAKED_DIR" ]; then
  mkdir -p "$PLACES_RUNTIME_DIR"
  # `cp -f` overwrite is safe: the tmpfs is per-container ephemeral.
  cp -f "$PLACES_BAKED_DIR"/*.json "$PLACES_RUNTIME_DIR"/ 2>/dev/null || \
    echo "[entrypoint] warning: no baked places JSON found at $PLACES_BAKED_DIR"
else
  echo "[entrypoint] warning: $PLACES_BAKED_DIR missing — image was built without baked places"
fi

# Fail-soft check. Script catches every throw and exits 0.
# We still `|| true` as belt-and-suspenders.
node /app/scripts/runtime/check-places-update.mjs || true

exec pnpm start
