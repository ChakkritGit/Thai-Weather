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
    # free tier allows 600/min; 11 variables may weigh slightly more than 1 call per location
    openmeteo_calls_per_minute: int | None = 400
    fallback_to_demo: bool = True

    horizon_hours: int = 48
    ensemble_members: int = 8
    refresh_minutes: int = 360  # 4 fetches/day fits Open-Meteo's free 10,000 calls/day
    run_on_startup: bool = True

    # radar nowcast (RainViewer) and tropical cyclones (GDACS); "off" disables the radar part
    nowcast_source: str = "rainviewer"  # "rainviewer" | "off"
    nowcast_poll_minutes: int = 5
    cyclones_enabled: bool = True

    data_dir: Path = Path("var")
    admin_token: str | None = None
    cors_origins: list[str] = ["*"]


@cache
def get_settings() -> Settings:
    return Settings()
