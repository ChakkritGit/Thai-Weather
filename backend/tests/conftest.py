from datetime import UTC, datetime

import pytest

from app.core.static import load_static
from app.downscale.pipeline import Downscaler
from app.sources.synthetic import SyntheticSource
from app.store import RunStore

START = datetime(2026, 10, 9, 0, tzinfo=UTC)


@pytest.fixture(scope="session")
def static():
    return load_static()


@pytest.fixture(scope="session")
def coarse():
    return SyntheticSource().fetch(START, 30)


@pytest.fixture(scope="session")
def run_dir(tmp_path_factory, static, coarse):
    root = tmp_path_factory.mktemp("data")
    store = RunStore(root)
    Downscaler(static, members=4).run(coarse, store)
    return root
