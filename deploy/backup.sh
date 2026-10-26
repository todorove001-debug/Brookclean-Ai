#!/usr/bin/env bash
# Ежедневная копия базы в бакет S3: backups/brookclean_ГГГГ-ММ-ДД_ЧЧММ.sql.gz
# cron: 30 3 * * * /opt/brookclean/deploy/backup.sh >> /var/log/brookclean-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
name="backups/brookclean_$(date +%F_%H%M).sql.gz"
docker compose exec -T db pg_dump -U brook brookclean | gzip | docker run --rm -i \
  -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" -e AWS_DEFAULT_REGION="$S3_REGION" \
  -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required -e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
  amazon/aws-cli --endpoint-url "$S3_ENDPOINT" s3 cp - "s3://$S3_BUCKET/$name"
echo "$(date '+%F %T') копия сохранена: $name"
