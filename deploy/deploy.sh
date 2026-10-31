#!/usr/bin/env bash
# Redeploys the backend on the server: pull, build, migrate, restart. Run with sudo.
set -euo pipefail

APP_DIR=/opt/aragon/app
ENV_FILE=/opt/aragon/backend.env
run_as_app() { sudo -u aragon -H bash -c "cd $APP_DIR && $1"; }

run_as_app "git pull --ff-only"
run_as_app "npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev"
# Node reads the env file itself, so values with spaces or <> need no shell quoting.
run_as_app "node --env-file=$ENV_FILE dist/db/migrate.js up"

systemctl restart aragon-api aragon-worker
sleep 2
systemctl is-active aragon-api aragon-worker
curl -fsS http://127.0.0.1:4000/health && echo
