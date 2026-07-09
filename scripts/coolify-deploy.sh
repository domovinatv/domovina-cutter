#!/usr/bin/env bash
# Trigger a redeploy of the Coolify application (picks up latest git + env).
# Usage: ./scripts/coolify-deploy.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/coolify-api.sh
. "$SCRIPT_DIR/lib/coolify-api.sh"

echo "→ Deploying app $COOLIFY_APP_UUID…"
coolify_app_deploy | jq -r '.message? // .' 2>/dev/null || true
echo "✅ Redeploy queued."
