"""Place lookup is local, bounded and available even before a forecast exists."""

import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.ratelimit import RateLimitMiddleware, Tier
from app.api.routes import router
from app.core.places import normalise, search_places
from scripts.build_places import build


@pytest.fixture
def client():
    app = FastAPI()  # deliberately no forecast store, scheduler, pushes or network clients
    app.include_router(router)
    app.add_middleware(RateLimitMiddleware, public=Tier("public", 3, 100), site=Tier("site", 10, 100))
    return TestClient(app)


@pytest.mark.parametrize("q", ["เชียงใหม่", "CHIANG MAI", "  Chiang-Mai  "])
def test_city_exact_match_precedes_province_and_substring(q):
    found = search_places(q)
    assert found[0]["id"] == 1153671
    assert found[0]["name_th"] == "เชียงใหม่"
    assert found[0]["province_th"] == "เชียงใหม่"
    assert found[0]["kind"] == "place"
    assert 18.7 < found[0]["lat"] < 18.9
    assert len(found) <= 10


def test_prefix_contains_district_and_thai_vowels():
    assert search_places("phatthaya")[0]["name_th"] == "พัทยา"  # English alternate name
    assert any(p["kind"] == "district" for p in search_places("ปากเกร็ด"))
    assert any(p["name_th"] == "กำแพงเพชร" for p in search_places("แพงเพชร"))
    assert normalise("กำแพงเพชร") != normalise("กแพงเพชร")
    assert normalise("Zimmé") == "zimme"


@pytest.mark.parametrize("q, name", [("Bangkok", "กรุงเทพมหานคร"), ("Ubon Ratchathani", "อุบลราชธานี")])
def test_known_province_names_use_the_full_thai_name(q, name):
    found = search_places(q)
    assert found[0]["name_th"] == name
    assert found[0]["province_th"] == name


@pytest.mark.parametrize("q", ["", "  ", "ก", "_!", "ไม่มีสถานที่นี้แน่นอน"])
def test_no_results_for_short_or_unknown_query(q):
    assert search_places(q) == []


def test_endpoint_without_forecast_and_query_limit(client):
    r = client.get("/api/v1/places", params={"q": "Bangkok"})
    assert r.status_code == 200
    assert r.json()["places"][0]["id"] == 1609350
    assert r.json()["attribution"]["name"] == "GeoNames"
    assert r.headers["cache-control"] == "public, max-age=3600"
    assert client.get("/api/v1/places").json()["places"] == []
    assert client.get("/api/v1/places", params={"q": "x" * 81}).status_code == 422


def test_search_uses_the_existing_api_rate_limit(client):
    headers = {"X-Real-IP": "198.51.100.70"}
    for _ in range(3):
        assert client.get("/api/v1/places?q=Bangkok", headers=headers).status_code == 200
    r = client.get("/api/v1/places?q=Bangkok", headers=headers)
    assert r.status_code == 429
    assert "retry-after" in r.headers


def test_builder_keeps_thai_aliases_and_only_supported_places(tmp_path):
    def row(id, feature, code, lat="13.75", country="TH"):
        return "\t".join(
            [
                str(id),
                "Amphoe Example",
                "Amphoe Example",
                "Example,อำเภอตัวอย่าง,ตัวอย่าง",
                lat,
                "100.5",
                feature,
                code,
                country,
                "",
                "40",
                "1001",
                "",
                "",
                "20",
                "",
                "",
                "Asia/Bangkok",
                "2026-10-01",
            ]
        )

    archive = tmp_path / "TH.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr(
            "TH.txt",
            "\n".join(
                [row(1, "A", "ADM2"), row(2, "S", "HTL"), row(3, "P", "PPL", "40"), row(4, "P", "PPL", country="LA")]
            ),
        )
    data = build(archive)
    assert len(data["places"]) == 1
    p = data["places"][0]
    assert p[1:3] == ["ตัวอย่าง", "Example"]
    assert "อำเภอตัวอย่าง" in p[9]
    assert data["districts"]["40.1001"] == ["ตัวอย่าง", "Example"]
