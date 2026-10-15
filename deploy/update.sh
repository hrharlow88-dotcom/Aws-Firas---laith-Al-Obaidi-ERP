#!/usr/bin/env bash
# Update to the latest code: back up first, then rebuild and restart. Migrations run on start.
#   cd laith-erp/deploy && sudo ./update.sh
set -euo pipefail
cd "$(dirname "$0")"
C="docker compose -f docker-compose.prod.yml"
stamp=$(date +%Y-%m-%d_%H%M)
echo "== Backup before update (backups/db_pre-update_${stamp}.dump)"
$C exec -T backup sh -c "pg_dump -Fc -f /backups/db_pre-update_${stamp}.dump"
git -C .. pull --ff-only
$C up -d --build
$C ps
