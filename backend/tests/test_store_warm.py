"""A new latest run is read into the page cache in the background."""

import time


def test_new_latest_run_is_warmed(run_dir):
    from app.store import RunStore

    store = RunStore(run_dir)
    run = store.latest()
    assert run is not None
    deadline = time.time() + 10
    while run._coarse_raw is None and time.time() < deadline:
        time.sleep(0.05)
    assert run._coarse_raw is not None  # warm() reached its last step
    assert store.latest() is run  # the same run is not warmed twice
