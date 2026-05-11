#!/usr/bin/env bash
# Idempotent script: ensures `tag:ci` exists in the Tailscale ACL tagOwners.
# Used by CI/CD setup to authorize GitHub Actions to register ephemeral nodes
# with the `tag:ci` tag via OAuth client (see docs/deploy.md).
#
# Usage:
#   TS_API_TOKEN=tskey-api-... ./setup-tailscale-ci-acl.sh [tailnet]
#
# - tailnet defaults to the local tailscale daemon's CurrentTailnet (requires
#   the tailscale CLI to be installed and logged in)
# - generate the API token at https://login.tailscale.com/admin/settings/keys
#   with scope "all" (the API uses tailnet-level tokens — no granular scope yet)
# - revoke the token once this script has run

set -euo pipefail

if [[ -z "${TS_API_TOKEN:-}" ]]; then
  echo "ERROR: TS_API_TOKEN env var is required" >&2
  exit 1
fi

TAILNET="${1:-}"
if [[ -z "$TAILNET" ]]; then
  if ! command -v tailscale >/dev/null; then
    echo "ERROR: pass tailnet as arg or install tailscale CLI" >&2
    exit 1
  fi
  TAILNET=$(tailscale status --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["CurrentTailnet"]["Name"])')
fi
echo "Tailnet: $TAILNET"

API="https://api.tailscale.com/api/v2/tailnet/$TAILNET/acl"
AUTH="Authorization: Bearer $TS_API_TOKEN"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "=== Fetching current ACL ==="
http_code=$(curl -sS -o "$tmp/acl.hujson" -D "$tmp/headers" -w '%{http_code}' \
  -H "$AUTH" -H "Accept: application/hujson" "$API")
if [[ "$http_code" != "200" ]]; then
  echo "ERROR: GET ACL failed (HTTP $http_code)" >&2
  cat "$tmp/acl.hujson" >&2
  exit 1
fi
etag=$(awk 'tolower($1)=="etag:"{print $2}' "$tmp/headers" | tr -d '\r')
echo "ETag: $etag"

if grep -qE '^[[:space:]]*"tagOwners"[[:space:]]*:' "$tmp/acl.hujson" \
   && grep -qE '"tag:ci"' "$tmp/acl.hujson"; then
  echo "tag:ci already present — no change needed"
  exit 0
fi

echo "=== Patching ACL ==="
# Case A: commented-out tagOwners example block (fresh tailnet).
if grep -qE '^[[:space:]]*//[[:space:]]*"tagOwners"[[:space:]]*:' "$tmp/acl.hujson"; then
  awk '
    /\/\/ "tagOwners": \{/ { print "\t\"tagOwners\": {"; print "\t\t\"tag:ci\": [\"autogroup:admin\"],"; print "\t},"; skip=2; next }
    skip > 0 { skip--; next }
    { print }
  ' "$tmp/acl.hujson" > "$tmp/acl.new.hujson"
# Case B: active tagOwners block missing tag:ci — insert after the opening brace.
elif grep -qE '^[[:space:]]*"tagOwners"[[:space:]]*:[[:space:]]*\{' "$tmp/acl.hujson"; then
  awk '
    /"tagOwners"[[:space:]]*:[[:space:]]*\{/ { print; print "\t\t\"tag:ci\": [\"autogroup:admin\"],"; next }
    { print }
  ' "$tmp/acl.hujson" > "$tmp/acl.new.hujson"
else
  echo "ERROR: no tagOwners block (commented or active) found in ACL." >&2
  echo "Add one manually then rerun, or extend this script for your layout." >&2
  exit 1
fi

echo "--- diff ---"
diff "$tmp/acl.hujson" "$tmp/acl.new.hujson" || true

echo "=== Posting new ACL ==="
http_code=$(curl -sS -X POST -o "$tmp/response" -w '%{http_code}' \
  -H "$AUTH" -H "Content-Type: application/hujson" -H "If-Match: $etag" \
  --data-binary "@$tmp/acl.new.hujson" "$API")
if [[ "$http_code" != "200" ]]; then
  echo "ERROR: POST ACL failed (HTTP $http_code)" >&2
  cat "$tmp/response" >&2
  exit 1
fi
echo "ACL updated (HTTP 200)"
echo "Revoke the API token now: https://login.tailscale.com/admin/settings/keys"
