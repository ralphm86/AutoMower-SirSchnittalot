"""GPS ingest: validation, batches, token auth."""

import time

import bcrypt
import pytest
from fastapi.testclient import TestClient

# GPS fixes must carry a plausible (not future) timestamp.
T0 = int(time.time()) - 3600


class TestGpsIngest:
    def test_rejects_out_of_range_coordinates(self, client):
        assert client.post("/api/gps/update", json={"lat": 91, "lon": 0}).status_code == 422
        assert client.post("/api/gps/update", json={"lat": 0, "lon": 181}).status_code == 422

    def test_rejects_negative_accuracy(self, client):
        r = client.post("/api/gps/update", json={"lat": 1, "lon": 1, "accuracy_m": -1})
        assert r.status_code == 422

    def test_rejects_implausible_timestamps(self, client):
        for ts in (0, 1_000_000_000, int(time.time()) + 86400):
            r = client.post("/api/gps/update", json={"lat": 1, "lon": 1, "ts": ts})
            assert r.status_code == 422, ts

    def test_batch_records_all_fixes_in_time_order(self, client):
        fixes = [{"ts": T0 + i * 2, "lat": 52.52, "lon": 13.405, "mowing": True}
                 for i in (3, 0, 2, 1)]
        r = client.post("/api/gps/batch", json={"fixes": fixes})
        assert r.status_code == 200
        assert r.json()["accepted"] == 4
        track = client.get("/api/gps/track?session=all").json()["track"]
        assert [p["ts"] for p in track] == [T0, T0 + 2, T0 + 4, T0 + 6]

    def test_batch_rejects_empty_and_oversized(self, client):
        assert client.post("/api/gps/batch", json={"fixes": []}).status_code == 422
        too_many = [{"ts": T0 + i, "lat": 1, "lon": 1} for i in range(501)]
        assert client.post("/api/gps/batch", json={"fixes": too_many}).status_code == 422

    def test_batch_rejects_one_bad_fix_as_a_whole(self, client):
        fixes = [{"ts": T0, "lat": 1, "lon": 1}, {"ts": T0 + 1, "lat": 99, "lon": 1}]
        assert client.post("/api/gps/batch", json={"fixes": fixes}).status_code == 422
        assert client.get("/api/gps/track?session=all").json()["track"] == []

    def test_track_is_thinned_but_keeps_the_newest_fix(self, client):
        fixes = [{"ts": T0 + i, "lat": 52.52, "lon": 13.405, "mowing": True}
                 for i in range(100)]
        client.post("/api/gps/batch", json={"fixes": fixes})
        body = client.get("/api/gps/track?session=all&max_points=10").json()
        assert len(body["track"]) <= 11
        assert body["track"][0]["ts"] == T0
        assert body["track"][-1]["ts"] == T0 + 99
        assert body["total_fixes"] == 100

    def test_ingest_does_not_count_as_web_activity(self, web, client):
        web._last_web_activity = 0.0
        web._ble_idle_suspend = True
        client.post("/api/gps/update", json={"ts": T0, "lat": 52.52, "lon": 13.405})
        assert web._last_web_activity == 0.0
        assert web._ble_idle_suspend is True
        client.get("/api/connection")
        assert web._last_web_activity > 0.0
        assert web._ble_idle_suspend is False


class TestGpsToken:
    @pytest.fixture
    def tokened(self, web, monkeypatch):
        monkeypatch.setattr(web, "_gps_token", "s3cret-token")
        return TestClient(web.app)

    def test_token_required_even_without_web_auth(self, tokened):
        r = tokened.post("/api/gps/update", json={"ts": T0, "lat": 1, "lon": 1})
        assert r.status_code == 401
        r = tokened.post("/api/gps/update", json={"ts": T0, "lat": 1, "lon": 1},
                         headers={"X-GPS-Token": "wrong"})
        assert r.status_code == 401

    def test_valid_token_is_accepted_on_both_endpoints(self, tokened):
        h = {"X-GPS-Token": "s3cret-token"}
        assert tokened.post("/api/gps/update", headers=h,
                            json={"ts": T0, "lat": 1, "lon": 1}).status_code == 200
        assert tokened.post("/api/gps/batch", headers=h,
                            json={"fixes": [{"ts": T0 + 1, "lat": 1, "lon": 1}]}).status_code == 200

    def test_token_bypasses_the_login_cookie(self, web, tokened):
        web._auth_hash = bcrypt.hashpw(b"hunter2", bcrypt.gensalt())
        r = tokened.post("/api/gps/update", headers={"X-GPS-Token": "s3cret-token"},
                         json={"ts": T0, "lat": 1, "lon": 1})
        assert r.status_code == 200

    def test_token_does_not_open_other_endpoints(self, web, tokened):
        web._auth_hash = bcrypt.hashpw(b"hunter2", bcrypt.gensalt())
        r = tokened.get("/api/connection", headers={"X-GPS-Token": "s3cret-token"})
        assert r.status_code == 401
        r = tokened.delete("/api/gps/track", headers={"X-GPS-Token": "s3cret-token"})
        assert r.status_code == 401

    def test_wrong_token_falls_back_to_cookie_auth(self, web, tokened):
        web._auth_hash = bcrypt.hashpw(b"hunter2", bcrypt.gensalt())
        r = tokened.post("/api/gps/update", headers={"X-GPS-Token": "nope"},
                         json={"ts": T0, "lat": 1, "lon": 1})
        assert r.status_code == 401

    def test_without_token_configured_ingest_follows_web_auth(self, web, client):
        web._auth_hash = bcrypt.hashpw(b"hunter2", bcrypt.gensalt())
        r = client.post("/api/gps/update", headers={"X-GPS-Token": "anything"},
                        json={"ts": T0, "lat": 1, "lon": 1})
        assert r.status_code == 401
