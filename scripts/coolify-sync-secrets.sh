#!/usr/bin/env bash
# Push the full env set the cutter service needs onto the Coolify application,
# then redeploy. Reads R2 credentials from the main fetch.domovina.tv repo .env
# (never copies them into this repo/git/chat) and CUTTER_API_KEY from this repo's
# .local-secrets.env.
#
# Usage:
#   ./scripts/coolify-sync-secrets.sh              # sync + redeploy
#   ./scripts/coolify-sync-secrets.sh --no-deploy  # sync only
#
# Config (in .local-secrets.env):
#   R2_SOURCE_ENV   — path to the source .env holding R2_* (default:
#                     ../fetch.domovina.tv/.env relative to this repo)
#   CUTTER_API_KEY  — bearer token the Worker sends (must match wrangler secret)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/coolify-api.sh
. "$SCRIPT_DIR/lib/coolify-api.sh"   # also loads .local-secrets.env (CUTTER_API_KEY, R2_SOURCE_ENV)

DEPLOY=true
for arg in "$@"; do
  case "$arg" in
    --no-deploy) DEPLOY=false ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

R2_SOURCE_ENV="${R2_SOURCE_ENV:-$REPO_ROOT/../fetch.domovina.tv/.env}"
[ -f "$R2_SOURCE_ENV" ] || { echo "❌ R2 source env not found: $R2_SOURCE_ENV (set R2_SOURCE_ENV in .local-secrets.env)" >&2; exit 1; }
: "${CUTTER_API_KEY:?Need CUTTER_API_KEY in .local-secrets.env}"

# Read one KEY= from an env file, stripping surrounding quotes. No echo of value.
getenv() {
  local key=$1 file=$2 line
  line=$(grep -E "^${key}=" "$file" | head -1 || true)
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

R2_ACCOUNT_ID=$(getenv R2_ACCOUNT_ID "$R2_SOURCE_ENV")
R2_ACCESS_KEY_ID=$(getenv R2_ACCESS_KEY_ID "$R2_SOURCE_ENV")
R2_SECRET_ACCESS_KEY=$(getenv R2_SECRET_ACCESS_KEY "$R2_SOURCE_ENV")

for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [ -n "${!v}" ] || { echo "❌ $v empty in $R2_SOURCE_ENV" >&2; exit 1; }
done

echo "→ App: $COOLIFY_APP_UUID"
echo "→ R2 source: $R2_SOURCE_ENV"
echo "→ Syncing env (values masked):"

set_one() {
  local k=$1 v=$2
  echo "   $k = $(coolify_mask "$v")"
  coolify_env_upsert "$k" "$v"
}

set_one R2_ACCOUNT_ID        "$R2_ACCOUNT_ID"
set_one R2_ACCESS_KEY_ID     "$R2_ACCESS_KEY_ID"
set_one R2_SECRET_ACCESS_KEY "$R2_SECRET_ACCESS_KEY"
set_one R2_BUCKET            "cdn-domovina-ai"
set_one CUTTER_API_KEY       "$CUTTER_API_KEY"
set_one PORT                 "8080"

echo "✅ env synced."

if $DEPLOY; then
  echo "→ Triggering redeploy…"
  coolify_app_deploy >/dev/null
  echo "✅ Redeploy queued. Container will restart with the new env in ~30-60s."
else
  echo "ℹ️  --no-deploy: run ./scripts/coolify-deploy.sh to apply."
fi
