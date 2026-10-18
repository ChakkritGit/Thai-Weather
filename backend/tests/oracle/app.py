"""Test-only ASGI contract oracle. Production has no ASGI HTTP server."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.config import get_settings
from app.engine.runtime import Services

from .ratelimit import RateLimitMiddleware, Tier
from .routes import router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    services = Services(get_settings())
    try:
        services.start()
        for name in ("store", "observations", "refresher", "nowcast", "push", "met", "air", "pm"):
            setattr(app.state, name, getattr(services, name))
        yield
    finally:
        services.close()


app = FastAPI(
    title="Thai Weather HD API",
    version="1.0.0",
    description=(
        "High-resolution (2 km) weather forecasts for Thailand, downscaled from "
        "global ~22 km models with terrain, coastline, urban and convective physics."
    ),
    lifespan=lifespan,
    # the schema of the public endpoints; the human docs are the site's /developers page
    openapi_url="/api/v1/openapi.json",
    docs_url=None,
    redoc_url=None,
)
_s = get_settings()
app.add_middleware(
    RateLimitMiddleware,
    public=Tier("public", _s.rate_per_min, _s.rate_per_day),
    site=Tier("site", _s.rate_site_per_min, _s.rate_site_per_day),
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=[
        *("X-Grid-NY", "X-Grid-NX", "X-Run-Id", "X-Frame-Time", "X-Lead", "X-Enc-Min", "X-Enc-Max"),
        *("X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"),
        *("X-RateLimit-Limit-Day", "X-RateLimit-Remaining-Day", "Retry-After"),
    ],
)
app.include_router(router)
