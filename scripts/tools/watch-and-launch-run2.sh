#!/usr/bin/env bash
# Watch a Run 1 precompute PID, launch Run 2 when it exits.
#
# Usage:
#   bash scripts/tools/watch-and-launch-run2.sh <run1-root-pid>
#
# The script polls every 60s. When the given PID is gone it runs the Run 2
# command and redirects everything to ./watch-run2.log. Designed to survive
# the terminal closing via `nohup` / `disown`:
#
#   nohup bash scripts/tools/watch-and-launch-run2.sh 50488 > watch-run2.log 2>&1 &
#   disown
#
set -u

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <run1-root-pid>"
  exit 2
fi
PID=$1

LOG=watch-run2.log
SELECTION=data/processed/precompute/high-value-tile-selection.top-priority.json

echo "[watch] $(date -Iseconds) — watching PID=$PID" | tee -a "$LOG"
echo "[watch] will launch run 2 with selection file: $SELECTION" | tee -a "$LOG"

# Poll every 60s. PowerShell Get-Process is cross-shell friendly on Windows,
# but `ps -p` works in Git Bash too via the MSYS shim.
while ps -p "$PID" > /dev/null 2>&1; do
  sleep 60
done

echo "[watch] $(date -Iseconds) — Run 1 (PID=$PID) exited. Launching Run 2." | tee -a "$LOG"

# Run 2 command — edit this block if you want different args.
# --skip-existing=true is what makes Run 2 fast (it picks up Run 1's delta).
cd "$(dirname "$0")/../.."  # repo root

pnpm precompute:all-regions:vulkan -- \
  --tile-selection-file="$SELECTION" \
  --start-date=2027-01-01 \
  --days=3 \
  --start-local-time=12:00 \
  --end-local-time=12:15 \
  --skip-existing=true \
  >> "$LOG" 2>&1

echo "[watch] $(date -Iseconds) — Run 2 exited with code $?." | tee -a "$LOG"
