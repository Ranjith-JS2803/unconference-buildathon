# Single-service image: builds the React frontend, then runs FastAPI, which
# serves both /api/* (incl. the SSE stream) and the built UI from frontend/dist.
# Used by render.yaml (runtime: docker). Works on any Docker host.

# ---- 1. build the frontend ------------------------------------------------
FROM node:20-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 2. python runtime ----------------------------------------------------
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.7.12 /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    DATA_DIR=/app/backend/data

WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/app ./app
COPY --from=web /app/frontend/dist /app/frontend/dist

# Render injects $PORT (default 10000). One worker on purpose: state lives in memory.
ENV PORT=10000
EXPOSE 10000
CMD ["sh", "-c", "exec /app/backend/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*' --timeout-keep-alive 75"]
