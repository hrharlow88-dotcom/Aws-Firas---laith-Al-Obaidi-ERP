#!/usr/bin/env bash
# Starts a separate copy of the system for another company on this server.
#   cd deploy && sudo ./new-company.sh <short-name> <domain> <owner-email>
# Example: ./new-company.sh rox rox-erp.example.com owner@example.com
# Demo copy for showing the system (made-up data, demo accounts allowed):
#   ./new-company.sh demo demo.<server-ip>.sslip.io owner@example.com --demo
# The copy has its own database, files and keys. Point the domain's DNS to this
# server first. Then sign in there, set the owner password with the printed
# link, and apply the company template from «لوحة المالك ← استنساخ لشركة».
set -euo pipefail
cd "$(dirname "$0")"
name="${1:?short name, letters and digits}"; domain="${2:?domain}"; email="${3:?owner e-mail}"; demo="false"
[ "${4:-}" = "--demo" ] && demo="true"
[[ "$name" =~ ^[a-z0-9]{2,20}$ ]] || { echo "Name: 2-20 lowercase letters/digits"; exit 1; }
envfile="companies/${name}.env"
rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
if [ ! -f "$envfile" ]; then
  cat > "$envfile" <<ENV
COMPANY=${name}
ERP_DOMAIN=${domain}
DB_NAME=erp_${name}
DB_USER=erp_${name}
DB_PASSWORD=$(rand 32)
JWT_SECRET=$(rand 64)
DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)
ADMIN_NAME=System Owner
ADMIN_EMAIL=${email}
ADMIN_PASSWORD=$(rand 24)
DEMO_MODE=${demo}
ENV
  chmod 600 "$envfile"
fi
docker compose --env-file "$envfile" -f docker-compose.company.yml up -d --build
printf '%s {\n\tencode gzip\n\treverse_proxy web-%s:80\n}\n' "$domain" "$name" > "companies/${name}.caddy"
docker compose -f docker-compose.prod.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile
sleep 8
if grep -q '^DEMO_MODE=true' "$envfile"; then
  echo "Filling the demo copy with made-up data..."
  docker compose --env-file "$envfile" -f docker-compose.company.yml exec -T api node dist/db/seedDemo.js || true
fi
echo "Started https://${domain}"
echo "Owner password link:"
docker compose --env-file "$envfile" -f docker-compose.company.yml exec -T api node dist/db/setupLink.js "${email}" || true
echo "BACK UP deploy/${envfile} outside this server (it holds the encryption key)."
