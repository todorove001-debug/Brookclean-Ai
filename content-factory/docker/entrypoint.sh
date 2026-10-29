#!/bin/sh
# Точка входа контейнера: api | worker | scheduler | bot | migrate | factory <команда>
set -e
case "$1" in
  api)
    exec uvicorn app.api.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' --no-server-header ;;
  worker)    exec python -m app.workers.worker ;;
  scheduler) exec python -m app.workers.scheduler ;;
  bot)       exec python -m app.workers.bot ;;
  migrate)   exec alembic -c alembic.ini upgrade head ;;
  factory)   shift; exec python -m app.cli "$@" ;;
  *)         exec "$@" ;;
esac
