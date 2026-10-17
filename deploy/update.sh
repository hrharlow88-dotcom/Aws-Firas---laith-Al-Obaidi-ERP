#!/usr/bin/env bash
# Update to the latest code: back up first, then rebuild and restart. Migrations run on start.
#   cd laith-erp/deploy && sudo ./update.sh
set -euo pipefail
cd "$(dirname "$0")"
C="docker compose -f docker-compose.prod.yml"
stamp=$(date +%Y-%m-%d_%H%M)
caddy_before=$(sha256sum Caddyfile | cut -d' ' -f1)
echo "== Backup before update (backups/db_pre-update_${stamp}.dump)"
# </dev/null: compose exec reads stdin, which stops the script when it runs in the background.
$C exec -T backup sh -c "pg_dump -Fc -f /backups/db_pre-update_${stamp}.dump" < /dev/null
git -C .. pull --ff-only
$C up -d --build
# The Caddyfile is mounted as a single file, which keeps pointing at the old
# copy once git replaces it; recreate the web server when its configuration changed.
if [ "$(sha256sum Caddyfile | cut -d' ' -f1)" != "$caddy_before" ]; then
  echo "== Caddyfile changed: recreating caddy"
  $C up -d --force-recreate --no-deps caddy
fi
$C ps
