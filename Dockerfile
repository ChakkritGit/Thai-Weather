# Single-container build: the FastAPI backend serves the built web app.
#   docker build -t thai-weather-hd .
#   docker run -p 8000:8000 -e THWX_SOURCE=open-meteo thai-weather-hd

FROM node:22-alpine AS web
WORKDIR /src
COPY design-system ./design-system
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY frontend ./frontend
COPY backend/app/data ./backend/app/data
RUN node design-system/scripts/build-tokens.mjs --check && cd frontend && npm run build

FROM python:3.12-slim AS api
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 THWX_DATA_DIR=/var/lib/thwx
WORKDIR /srv/backend
COPY backend/pyproject.toml ./
RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn[standard]>=0.30" "numpy>=2.0" "scipy>=1.13" "httpx>=0.27" "pydantic-settings>=2.4"
COPY backend/app ./app
COPY --from=web /src/frontend/dist /srv/frontend/dist
RUN useradd --system --uid 10001 thwx && mkdir -p /var/lib/thwx && chown thwx /var/lib/thwx
USER thwx
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
