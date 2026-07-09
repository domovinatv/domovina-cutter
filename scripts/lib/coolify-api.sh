#!/usr/bin/env bash
# scripts/lib/coolify-api.sh
#
# Sourced by the coolify-*.sh scripts. Coolify v4 REST API (Bearer auth).
# Same pattern as domovina-api/scripts/lib/coolify-api.sh, but this repo is a
# Coolify APPLICATION (Dockerfile build), not a `service` → /applications/{uuid}.
#
# Required env (from .local-secrets.env — gitignored):
#   COOLIFY_API_URL     — e.g. https://app.domovina.link (no trailing /)
#   COOLIFY_API_TOKEN   — Bearer token (Keys & Tokens → API Tokens, Read+Write)
#   COOLIFY_APP_UUID    — application UUID (from the Coolify app URL)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRETS_FILE="${SECRETS_FILE:-$REPO_ROOT/.local-secrets.env}"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "❌ $SECRETS_FILE missing. cp .local-secrets.env.example .local-secrets.env and fill it." >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
. "$SECRETS_FILE"
set +a

: "${COOLIFY_API_URL:?Need COOLIFY_API_URL in .local-secrets.env}"
: "${COOLIFY_API_TOKEN:?Need COOLIFY_API_TOKEN in .local-secrets.env}"
: "${COOLIFY_APP_UUID:?Need COOLIFY_APP_UUID in .local-secrets.env}"

COOLIFY_API_URL="${COOLIFY_API_URL%/}"
COOLIFY_API_BASE="$COOLIFY_API_URL/api/v1"

command -v jq >/dev/null || { echo "❌ jq not installed. brew install jq" >&2; exit 1; }

# curl wrapper: Bearer auth + JSON. HTTP code → stderr, body → stdout.
# Usage: coolify_curl GET  /applications/uuid/envs
#        coolify_curl PATCH /applications/uuid/envs --data '{...}'
coolify_curl() {
  local method=$1 path=$2; shift 2
  local tmp; tmp=$(mktemp)
  local code
  code=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X "$method" \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    "$@" \
    "$COOLIFY_API_BASE$path" || echo "000")
  echo "$code" >&2
  cat "$tmp"
  rm -f "$tmp"
}

# Upsert one env var on the application. Returns 0 on success.
# Never prints the value.
coolify_env_upsert() {
  local key=$1 value=$2
  local envs code exists payload resp
  envs=$(coolify_curl GET "/applications/$COOLIFY_APP_UUID/envs" 2>/tmp/_cc); code=$(cat /tmp/_cc); rm -f /tmp/_cc
  [ "$code" = "200" ] || { echo "❌ GET envs failed: HTTP $code" >&2; return 1; }
  exists=$(echo "$envs" | jq --arg k "$key" 'any(.[]?; .key == $k)')
  payload=$(jq -nc --arg k "$key" --arg v "$value" '{key:$k, value:$v, is_preview:false}')
  if [ "$exists" = "true" ]; then
    resp=$(coolify_curl PATCH "/applications/$COOLIFY_APP_UUID/envs" --data "$payload" 2>/tmp/_cc); code=$(cat /tmp/_cc); rm -f /tmp/_cc
    if [ "$code" = "404" ] || [ "$code" = "405" ]; then
      resp=$(coolify_curl POST "/applications/$COOLIFY_APP_UUID/envs" --data "$payload" 2>/tmp/_cc); code=$(cat /tmp/_cc); rm -f /tmp/_cc
    fi
  else
    resp=$(coolify_curl POST "/applications/$COOLIFY_APP_UUID/envs" --data "$payload" 2>/tmp/_cc); code=$(cat /tmp/_cc); rm -f /tmp/_cc
  fi
  case "$code" in
    200|201|204) return 0 ;;
    *) echo "❌ upsert $key failed: HTTP $code" >&2; echo "$resp" | head -5 >&2; return 1 ;;
  esac
}

# Trigger a (re)deploy so the app container picks up new env. Async in Coolify.
coolify_app_deploy() {
  local resp code
  resp=$(coolify_curl GET "/deploy?uuid=$COOLIFY_APP_UUID" 2>/tmp/_cc); code=$(cat /tmp/_cc); rm -f /tmp/_cc
  case "$code" in
    200|201) echo "$resp" ;;
    *) echo "❌ deploy failed: HTTP $code" >&2; echo "$resp" | head -5 >&2; return 1 ;;
  esac
}

# mask a value for logs
coolify_mask() {
  local v=$1 n=${#1}
  if [ -z "$v" ]; then printf '<empty>'
  elif [ "$n" -le 8 ]; then printf '%*s' "$n" '' | tr ' ' '*'
  else printf '%s…%s (len=%d)' "${v:0:4}" "${v: -4}" "$n"
  fi
}

export COOLIFY_API_BASE COOLIFY_APP_UUID
export -f coolify_curl coolify_env_upsert coolify_app_deploy coolify_mask
