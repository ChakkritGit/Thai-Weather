from app.core.grid import FINE_GRID, grid_for


def test_coarse_grid_reports_real_last_cell_centre():
    d = grid_for(0.25).describe()
    assert d["nx"] == 35
    assert d["lon1"] == 105.8
    assert d["lat1"] == 20.5


def test_fine_grid_describe_unchanged():
    d = FINE_GRID.describe()
    assert d["lon1"] == 105.7
    assert d["lat1"] == 20.5
