#!/usr/bin/env bash
# Set (create or update) one env var on the Coolify application, optionally
# triggering a redeploy so the container picks it up.
#
# Usage:
#   ./scripts/coolify-env-set.sh KEY=VALUE            # set, no deploy
#   ./scripts/coolify-env-set.sh KEY=VALUE --deploy   # set + redeploy
#
# Value is never printed (masked in logs). Coolify does NOT restart the app on
# env change — pass --deploy (or run scripts/coolify-deploy.sh) to apply it.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/coolify-api.sh
. "$SCRIPT_DIR/lib/coolify-api.sh"

DEPLOY=false
KV=""
for arg in "$@"; do
  case "$arg" in
    --deploy) DEPLOY=true ;;
    --*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *) KV="$arg" ;;
  esac
done

[ -n "$KV" ] && [[ "$KV" == *=* ]] || { echo "Usage: $0 KEY=VALUE [--deploy]" >&2; exit 2; }
KEY="${KV%%=*}"; VALUE="${KV#*=}"
[ -n "$KEY" ] || { echo "❌ empty KEY" >&2; exit 2; }

echo "→ App: $COOLIFY_APP_UUID"
echo "→ Set $KEY = $(coolify_mask "$VALUE")"
coolify_env_upsert "$KEY" "$VALUE"
echo "✅ $KEY set."

if $DEPLOY; then
  echo "→ Triggering redeploy…"
  coolify_app_deploy >/dev/null
  echo "✅ Redeploy queued."
fi
