#!/usr/bin/env bash
# One-time move of the server from the two systemd services (round 1) to Docker Compose. Run with sudo.
# nginx, Redis and the env file stay on the host exactly as they are.
set -euo pipefail

apt-get update -q
apt-get install -y -q docker.io docker-compose-v2
systemctl enable --now docker

# Build first, so the API is only down for the restart itself.
cd /opt/aragon/app
docker compose build
systemctl disable --now aragon-api aragon-worker
/opt/aragon/app/deploy/deploy.sh
