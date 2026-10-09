from __future__ import annotations

from functools import cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration (environment variables prefixed ``THWX_``)."""

    model_config = SettingsConfigDict(env_prefix="THWX_", env_file=".env", extra="ignore")

    source: str = "demo"  # "demo" | "open-meteo"
    openmeteo_model: str = "gfs_seamless"
    openmeteo_spacing: float = 0.25
    openmeteo_api_key: str | None = None
    fallback_to_demo: bool = True

    horizon_hours: int = 48
    ensemble_members: int = 8
    refresh_minutes: int = 180
    run_on_startup: bool = True

    data_dir: Path = Path("var")
    admin_token: str | None = None
    cors_origins: list[str] = ["*"]


@cache
def get_settings() -> Settings:
    return Settings()
