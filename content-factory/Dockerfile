# Контент-фабрика Brookclean: один образ для API, worker, scheduler и bot.
FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# FFmpeg (libass, freetype) — монтаж и проверка видео; шрифты DejaVu — шаблоны и субтитры;
# postgresql-client — pg_dump/pg_restore для резервных копий.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fontconfig postgresql-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

RUN pip install "uv==0.11.32"

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app
COPY migrations ./migrations
COPY alembic.ini README.md ./
COPY config ./config
RUN uv sync --frozen --no-dev

RUN useradd --system --uid 10001 --home /app factory \
 && mkdir -p /app/var/media /app/var/work \
 && chown -R factory /app/var
USER factory

ENV PATH="/app/.venv/bin:$PATH" \
    WORK_DIR=/app/var/work \
    STORAGE_DIR=/app/var/media

EXPOSE 8000
ENTRYPOINT ["tini", "--", "docker/entrypoint.sh"]
CMD ["api"]
COPY --chown=factory docker/entrypoint.sh docker/entrypoint.sh
