#!/usr/bin/env bash
# For GitHub Actions: masks in the log what would tie this repository to the Cloudflare account
# it deploys to: the account's workers.dev subdomain, and the account's name, which Cloudflare
# makes from its owner's email address and Wrangler prints when something goes wrong.
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Prints nothing but the masks.
set -uo pipefail
api() {
  curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID$1" 2>/dev/null || true
}
subdomain=$(api /workers/subdomain | jq -r '.result.subdomain // empty' 2>/dev/null)
if [ -n "$subdomain" ]; then echo "::add-mask::$subdomain"; fi
name=$(api "" | jq -r '.result.name // empty' 2>/dev/null)
if [ -n "$name" ]; then
  echo "::add-mask::$name"
  owner=${name%"'s Account"}
  if [ "$owner" != "$name" ]; then echo "::add-mask::$owner"; fi
  local=${owner%@*}
  if [ "$local" != "$owner" ]; then echo "::add-mask::$local"; fi
fi
exit 0
