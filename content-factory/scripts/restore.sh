#!/usr/bin/env bash
# Восстановление базы из копии: bash scripts/restore.sh backups/db/factory-20261101T033000Z.dump
set -euo pipefail
cd "$(dirname "$0")/.."
key="${1:?укажите ключ копии (список: docker compose run --rm api factory backup list)}"
read -r -p "База будет перезаписана копией ${key}. Продолжить? (yes/no) " answer
[ "$answer" = "yes" ] || exit 1
docker compose stop worker scheduler bot api
docker compose run --rm -T api factory backup restore "$key" --yes
docker compose up -d
