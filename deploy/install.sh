#!/usr/bin/env bash
# First installation on a fresh Linux server with Docker.
#   cd deploy && ./install.sh
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "Install Docker first: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose v2 is required."; exit 1; }

if [ ! -f .env ]; then
  read -rp "Domain or server address (e.g. erp.alobaidi-cars.com): " domain
  read -rp "Administrator e-mail: " admin_email
  read -rp "Administrator name: " admin_name
  rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  admin_password=$(rand 20)
  cat > .env <<ENV
ERP_DOMAIN=${domain}
ACME_EMAIL=${admin_email}
DB_NAME=laith_erp
DB_USER=laith_erp_app
DB_PASSWORD=$(rand 32)
JWT_SECRET=$(rand 48)
DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)
ADMIN_NAME="${admin_name}"
ADMIN_EMAIL=${admin_email}
ADMIN_PASSWORD="${admin_password}"
DEVICE_PORT=8081
BACKUP_DIR=./backups
BACKUP_KEEP_DAYS=14
BACKUP_HOUR=2
SAP_B1_URL=
SAP_B1_COMPANY_DB=
SAP_B1_USER=
SAP_B1_PASSWORD=
SAP_B1_LOCAL_CURRENCY=IQD
ENV
  chmod 600 .env
  echo
  echo "================================================================"
  echo " Administrator password: ${admin_password}"
  echo " Change it after the first login."
  echo " BACK UP deploy/.env NOW (outside this server). Without"
  echo " DATA_ENCRYPTION_KEY the stored ID and bank numbers cannot be read."
  echo "================================================================"
fi
mkdir -p backups company-data
docker compose -f docker-compose.prod.yml up -d --build
echo "Started. Open https://$(grep ^ERP_DOMAIN= .env | cut -d= -f2)"
