"""FastAPI application entry point.

uvicorn app.main:app --reload
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .api.routes import router
from .config import get_settings
from .core.static import load_static
from .scheduler import ObservationBuffer, Refresher
from .store import RunStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    load_static()  # fail fast if static data is missing
    store = RunStore(settings.data_dir)
    observations = ObservationBuffer()
    refresher = Refresher(settings, store, observations)
    app.state.store = store
    app.state.observations = observations
    app.state.refresher = refresher
    refresher.start()
    yield
    refresher.stop()


app = FastAPI(
    title="Thai Weather HD API",
    version="1.0.0",
    description=(
        "High-resolution (2 km) weather forecasts for Thailand, downscaled from "
        "global ~22 km models with terrain, coastline, urban and convective physics."
    ),
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["X-Grid-NY", "X-Grid-NX", "X-Run-Id"],
)
app.include_router(router)
