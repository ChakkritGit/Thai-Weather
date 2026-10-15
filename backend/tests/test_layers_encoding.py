"""Temperatures below zero survive encoding; runs written before keep decoding the old way."""

import numpy as np

from app.downscale.layers import LAYERS, LEGACY_ENCODINGS, encodings_record, run_encoding


def test_temperature_goes_below_zero():
    enc = LAYERS["temp"].encoding
    back = enc.decode(enc.encode(np.array([-12.0, -0.5, 0.0, 33.4])))
    assert np.allclose(back, [-12.0, -0.5, 0.0, 33.4], atol=0.15)


def test_a_run_decodes_with_the_encoding_it_was_written_with():
    old = run_encoding({}, "temp")  # a run from before meta["encodings"]
    assert (old.min, old.max) == (LEGACY_ENCODINGS["temp"].min, LEGACY_ENCODINGS["temp"].max)
    code = LEGACY_ENCODINGS["temp"].encode(np.array([30.0]))
    assert abs(float(old.decode(code)[0]) - 30.0) < 0.15
    new = run_encoding({"encodings": encodings_record()}, "temp")
    assert new.min == -20.0
    assert run_encoding({}, "rh").max == 100.0  # untouched layers come from LAYERS
