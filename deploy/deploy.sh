#!/usr/bin/env bash
# Redeploys on the server: pull, build the image, migrate, then (re)start every service with Docker
# Compose. Run with sudo. Copies per service come from the environment, e.g.
#   sudo CONVERSION=3 VARIANTS=2 /opt/aragon/app/deploy/deploy.sh
set -euo pipefail

APP_DIR=/opt/aragon/app
cd "$APP_DIR"

sudo -u aragon -H git pull --ff-only
docker compose build
# Migrations are additive and run before the new code starts.
docker compose run --rm api node dist/db/migrate.js up
docker compose up -d --remove-orphans \
  --scale validation="${VALIDATION:-1}" \
  --scale conversion="${CONVERSION:-1}" \
  --scale compression="${COMPRESSION:-1}" \
  --scale variants="${VARIANTS:-1}"

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/health; then echo; break; fi
  sleep 1
done
docker compose ps --format 'table {{.Service}}\t{{.Name}}\t{{.Status}}'
