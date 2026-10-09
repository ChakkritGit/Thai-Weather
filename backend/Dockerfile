# FastAPI backend: downscaling engine + REST API
FROM python:3.12-slim
LABEL org.opencontainers.image.source="https://github.com/ChakkritGit/Thai-Weather" \
      org.opencontainers.image.description="Thai Weather HD – 2 km downscaling API"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 THWX_DATA_DIR=/var/lib/thwx
WORKDIR /srv/backend
COPY pyproject.toml ./
RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn[standard]>=0.30" "numpy>=2.0" "scipy>=1.13" "httpx>=0.27" "pydantic-settings>=2.4" "pywebpush>=2.0,<3" "pillow>=10"
COPY app ./app
COPY verify ./verify
RUN useradd --system --uid 10001 thwx && mkdir -p /var/lib/thwx && chown thwx /var/lib/thwx
USER thwx
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
