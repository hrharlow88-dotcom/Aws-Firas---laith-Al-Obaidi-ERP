#!/usr/bin/env bash
# First installation on a fresh Ubuntu server (Hostinger VPS or the company's own machine).
#
#   git clone https://github.com/hrharlow88-dotcom/Aws-Firas---laith-Al-Obaidi-ERP.git laith-erp
#   cd laith-erp/deploy && sudo ./install.sh
#
# Non-interactive (values via environment):
#   sudo ERP_DOMAIN=srv123.hstgr.cloud ADMIN_EMAIL=aws.firas@alobaidi-cars.com ADMIN_NAME="أوس فراس" ./install.sh
#
# ERP_DOMAIN defaults to the server's own host name: Hostinger VPS servers have a public
# name such as srv123456.hstgr.cloud, which is enough for an automatic HTTPS certificate.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo so Docker can be installed."; exit 1; fi
  echo "Installing Docker…"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl openssl
  curl -fsSL https://get.docker.com | sh
fi

# Firewall: SSH, web, and the plain-HTTP port for fingerprint devices.
if command -v ufw >/dev/null && [ "$(id -u)" -eq 0 ]; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow "${DEVICE_PORT:-8081}"/tcp >/dev/null
  ufw --force enable >/dev/null || true
fi

if [ ! -f .env ]; then
  domain="${ERP_DOMAIN:-}"
  if [ -z "$domain" ]; then
    guess=$(hostname -f 2>/dev/null || hostname)
    if [ -t 0 ]; then read -rp "Domain or server name [${guess}]: " domain; fi
    domain="${domain:-$guess}"
  fi
  admin_email="${ADMIN_EMAIL:-}"
  [ -z "$admin_email" ] && [ -t 0 ] && read -rp "Administrator e-mail: " admin_email
  admin_name="${ADMIN_NAME:-}"
  [ -z "$admin_name" ] && [ -t 0 ] && read -rp "Administrator name: " admin_name
  if [ -z "$admin_email" ]; then echo "ADMIN_EMAIL is required."; exit 1; fi
  admin_name="${admin_name:-مسؤول النظام}"
  rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  admin_password=$(rand 20)
  umask 077
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
  echo " Server:                 https://${domain}"
  echo " Administrator e-mail:   ${admin_email}"
  echo " Administrator password: ${admin_password}"
  echo " Change the password after the first login."
  echo " BACK UP deploy/.env NOW (outside this server). Without"
  echo " DATA_ENCRYPTION_KEY the stored ID and bank numbers cannot be read."
  echo "================================================================"
fi
mkdir -p backups company-data
docker compose -f docker-compose.prod.yml up -d --build
echo "Started. Open https://$(grep ^ERP_DOMAIN= .env | cut -d= -f2)"
