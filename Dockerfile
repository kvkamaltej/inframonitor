# syntax=docker/dockerfile:1
#
# One image, one process: uvicorn serves the FastAPI API and the pre-built
# static UI from the same origin. Node exists only in the build stage and is
# never copied forward, so the runtime image has no JavaScript toolchain in it.

# ---------------------------------------------------------------------------
# Stage 1 -- build the Next.js static export. Build-time only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS ui

WORKDIR /app

# Dependencies first so this layer caches until the lockfile changes.
# `npm ci` and not `npm install`: install resolves versions afresh and ignores
# package-lock.json, which makes image builds non-reproducible.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# .dockerignore strips node_modules/.next/out, so this cannot clobber the
# node_modules we just installed.
COPY frontend/ ./

# next.config.mjs sets output:"export", so `next build` emits ./out instead of
# a server bundle. No NEXT_PUBLIC_API_URL is passed on purpose: the UI calls a
# relative /api and is served by the same process as the API, so there is no
# host or port to bake in.
RUN npm run build && test -d out

# ---------------------------------------------------------------------------
# Stage 2 -- runtime. Python only.
# ---------------------------------------------------------------------------
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

# postgresql-client provides pg_dump / pg_restore / psql for the database backup & restore feature
# (app/services/db_backup.py shells out to them). Installed lean: no recommends, apt lists removed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app

# The static export becomes /app/static, which is config.py's `static_dir`
# default and what main.py mounts at "/".
COPY --from=ui /app/out ./static

# Run as a non-root user. Every container in the previous stack ran as root.
#
# /app/data is where the inframonitor_data volume mounts and where the SQLite file
# lives. The *directory* has to be writable by the runtime uid, not just the
# database file: in WAL mode SQLite creates and deletes inframonitor.db-wal and
# inframonitor.db-shm siblings next to it. Chowning it here also means a freshly
# created named volume inherits this ownership, since Docker seeds a new volume
# from the image's content and permissions at that path.
RUN groupadd --gid 10001 inframonitor \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin inframonitor \
 && mkdir -p /app/data \
 && chown -R inframonitor:inframonitor /app/data

USER inframonitor

EXPOSE 8000

# Deliberately no --workers. SQLite allows a single writer, and the startup
# migration step (create_all plus the ALTER TABLE loop) is not safe to run from
# several processes at once.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
