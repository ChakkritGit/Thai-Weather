# Thai place index

`places.json` is derived from the [GeoNames Thailand dump](https://download.geonames.org/export/dump/TH.zip),
downloaded on 2026-10-17. GeoNames data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The search UI and API credit GeoNames. Local transformations keep provinces (ADM1), districts (ADM2),
and populated places (feature class P) inside the forecast domain, select Thai/English names and aliases,
and round coordinates to five decimal places. Known province/city names use the repository's full Thai
province name when it is also present in GeoNames aliases. Missing Thai names fall back to English in the UI.

To regenerate, download the archive **outside this public repository** and run from `backend/`:

```sh
.venv/bin/python scripts/build_places.py /tmp/TH.zip
```

The API loads this index locally and does not call GeoNames or trigger forecast runs.
