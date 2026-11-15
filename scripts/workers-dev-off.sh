#!/usr/bin/env bash
# Turns off a Worker's workers.dev address and its preview addresses, for a Worker that is served
# from a domain of its own. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
#   scripts/workers-dev-off.sh tickflare-docs
set -euo pipefail
curl -fsS -o /dev/null -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$1/subdomain" \
  --data '{"enabled":false,"previews_enabled":false}'
echo "workers.dev is off for $1."
