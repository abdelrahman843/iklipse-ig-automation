#!/usr/bin/env bash
# Deploys the OAuth connect flow. Run after exporting a fresh Supabase access token:
#   export SUPABASE_ACCESS_TOKEN=sbp_xxx
#   bash deploy-oauth.sh
set -e
REF=mbjtzrrcnkxossepbrfw

# 1. secrets the connect flow needs (IG_APP_SECRET falls back to META_APP_SECRET automatically)
npx supabase secrets set \
  IG_APP_ID="${IG_APP_ID:-828878416441389}" \
  IG_REDIRECT_URI="https://$REF.supabase.co/functions/v1/ig-oauth" \
  APP_URL="${APP_URL:-http://localhost:5173}" \
  --project-ref "$REF"

# 2. new functions
npx supabase functions deploy ig-oauth         --project-ref "$REF"
npx supabase functions deploy ig-token-refresh --project-ref "$REF"

# 3. redeploy the two that now read the token from the DB (meta.ts changed)
npx supabase functions deploy process-events   --project-ref "$REF"
npx supabase functions deploy send-worker       --project-ref "$REF"

echo "done."
