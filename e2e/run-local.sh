#!/bin/sh
# The screen check on a throwaway copy: a fresh database named *e2e* filled with
# made-up data (the demo seed), the API on port 5077, then every screen in
# Chromium at 1440, 390 and 320 px. Exits non-zero if any screen fails.
#
#   cd backend && npm run build; cd ../frontend && npm run build; cd ../e2e && npm install && sh run-local.sh
#
# Uses the same local PostgreSQL login as the backend tests (DB_USER/DB_PASSWORD
# override it). Every secret here is made up for this run and thrown away.
set -eu
cd "$(dirname "$0")"
export DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-5432}" DB_USER="${DB_USER:-erp}" DB_PASSWORD="${DB_PASSWORD:-erp_dev_pw}"
export DB_NAME="${E2E_DB_NAME:-laith_erp_e2e}" DB_SSL=false
case "$DB_NAME" in *e2e*) ;; *) echo "Refusing: the database name must contain e2e." >&2; exit 1 ;; esac
random() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('$2'))"; }
export PORT="${E2E_PORT:-5077}" DEMO_MODE=true DISABLE_BACKGROUND_JOBS=true
export JWT_SECRET="e2e-$(random 24 hex)" ADMIN_PASSWORD="$(random 18 hex)" DATA_ENCRYPTION_KEY="$(random 32 base64)"
export ADMIN_EMAIL=owner@e2e.local ADMIN_NAME="مالك الفحص"
export UPLOAD_DIR="${TMPDIR:-/tmp}/laith-erp-e2e-uploads"
export PGPASSWORD="$DB_PASSWORD"

psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -qc "DROP DATABASE IF EXISTS $DB_NAME" -c "CREATE DATABASE $DB_NAME"
node ../backend/dist/server.js > api.log 2>&1 &
API=$!
trap 'kill $API 2>/dev/null || true' EXIT
tries=0
until curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null; do
  tries=$((tries + 1)); [ "$tries" -lt 60 ] || { echo "The API did not start; see e2e/api.log" >&2; exit 1; }
  sleep 1
done
node ../backend/dist/db/seedDemo.js > seed.log 2>&1 || { echo "The demo seed failed; see e2e/seed.log" >&2; exit 1; }
node tokens.mjs > tokens.json
BASE="http://127.0.0.1:$PORT" TOKENS=tokens.json node screens.mjs
# The photo ZIP flow changes data, so it runs after the screens were measured.
[ "${SKIP_FLOWS:-}" = "1" ] || BASE="http://127.0.0.1:$PORT" TOKENS=tokens.json node photo-zip.mjs
