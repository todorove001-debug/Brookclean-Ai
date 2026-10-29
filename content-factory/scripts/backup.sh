#!/usr/bin/env bash
# Резервная копия базы в объектное хранилище (папка S3_BACKUP_PREFIX/db/). Для cron.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose run --rm -T api factory backup create
