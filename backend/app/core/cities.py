"""Urban centres used for the urban-heat-island (UHI) correction.

Intensities are maximum night-time UHI (°C) and e-folding radius (km).
Bangkok values follow published observational studies of the Bangkok
Metropolitan Region (night-time UHI of roughly 2–4 °C); the others are
scaled by urban extent.  Global models at ~22 km cannot represent these.
"""

CITIES: list[dict] = [
    {"name": "Bangkok", "lat": 13.7563, "lon": 100.5018, "uhi": 3.0, "radius_km": 22.0},
    {"name": "Chiang Mai", "lat": 18.7883, "lon": 98.9853, "uhi": 1.8, "radius_km": 7.0},
    {"name": "Nakhon Ratchasima", "lat": 14.9799, "lon": 102.0978, "uhi": 1.5, "radius_km": 6.0},
    {"name": "Khon Kaen", "lat": 16.4419, "lon": 102.8360, "uhi": 1.5, "radius_km": 6.0},
    {"name": "Udon Thani", "lat": 17.4138, "lon": 102.7872, "uhi": 1.3, "radius_km": 5.0},
    {"name": "Hat Yai", "lat": 7.0086, "lon": 100.4747, "uhi": 1.5, "radius_km": 6.0},
    {"name": "Chon Buri – Pattaya", "lat": 13.2, "lon": 100.95, "uhi": 1.4, "radius_km": 9.0},
    {"name": "Phuket", "lat": 7.8804, "lon": 98.3923, "uhi": 1.2, "radius_km": 5.0},
    {"name": "Phitsanulok", "lat": 16.8211, "lon": 100.2659, "uhi": 1.2, "radius_km": 4.5},
    {"name": "Ubon Ratchathani", "lat": 15.2287, "lon": 104.8564, "uhi": 1.2, "radius_km": 5.0},
    {"name": "Nakhon Sawan", "lat": 15.7047, "lon": 100.1372, "uhi": 1.1, "radius_km": 4.5},
    {"name": "Surat Thani", "lat": 9.1382, "lon": 99.3215, "uhi": 1.0, "radius_km": 4.0},
]
