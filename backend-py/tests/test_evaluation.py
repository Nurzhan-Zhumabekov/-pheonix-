import copy
import sys
from fractions import Fraction
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import organizers  # noqa: E402
import scoring_stub  # noqa: E402
from main import app  # noqa: E402

CONV = {
    "conversation_id": "p1-ru-002",
    "channel": "agent chat",
    "language": "RU",
    "transcript": [
        {"timestamp": "00:01", "speaker": "client", "text": "Здравствуйте, нужна помощь"},
        {"timestamp": "00:05", "speaker": "operator", "text": "Добрый день! Меня зовут Анна."},
        {"timestamp": "00:20", "speaker": "bot", "text": "служебное"},
        {"timestamp": "00:30", "speaker": "operator", "text": "Готово, всего доброго."},
    ],
    "audio_url": None,
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path))
    monkeypatch.delenv("CONTROL_API_URL", raising=False)
    monkeypatch.setitem(organizers._cache, "dev", [copy.deepcopy(CONV)])
    return TestClient(app)


# ---- scoring_stub ----

def _items(**kw):
    # Пример из CLAUDE.md: 1,3,7 Да; 2 N/A; 4=15; 5 Нет; 6=7
    spec = [
        ("start", 10, "yes", "binary", None), ("start", 15, "na", "binary", None),
        ("safety", 20, "yes", "binary", None), ("safety", 20, 15, "scale", [0, 5, 10, 15, 20]),
        ("flow", 15, "no", "binary", None), ("flow", 15, 7, "scale", [0, 4, 7, 10]),
        ("flow", 5, "yes", "binary", None),
    ]
    return [{"section": s, "weight": w, "share": scoring_stub.share_of(t, a, sc)} for s, w, a, t, sc in spec]


def test_claude_md_example_gives_71_18():
    total, sections = scoring_stub.score(_items(), ["start", "safety", "flow"])
    assert total == 71.18
    by_id = {s["id"]: s["score"] for s in sections}
    assert by_id["start"] == 100.0       # применим только критерий 1
    assert by_id["safety"] == 87.5       # (20 + 15) / 40
    assert by_id["flow"] == 44.29        # (0 + 10.5 + 5) / 35


def test_na_is_excluded_from_both_sums():
    items = [{"section": None, "weight": 10, "share": 1.0}, {"section": None, "weight": 90, "share": None}]
    assert scoring_stub.score(items, [])[0] == 100.0


def test_no_applicable_criteria_gives_null():
    assert scoring_stub.score([{"section": None, "weight": 10, "share": None}], ["x"]) == (None, [{"id": "x", "score": None}])
    assert scoring_stub.score([], [])[0] is None
    # критерий с нулевым весом не считается применимым
    assert scoring_stub.score([{"section": None, "weight": 0, "share": 1.0}], [])[0] is None


def test_round_half_up():
    assert scoring_stub.round_half_up(Fraction(12345, 1000)) == 12.35
    items = [{"section": None, "weight": 1, "share": 0.12345}]
    assert scoring_stub.score(items, [])[0] == 12.35


# ---- endpoints ----

def test_evaluate_returns_mock_with_real_quotes_and_saves(client):
    r = client.post("/api/evaluate", json={"conversation_id": "p1-ru-002"})
    assert r.status_code == 200
    ev = r.json()
    assert ev["mock"] is True and ev["model"]["name"] == "mock"
    assert ev["conversation_id"] == "p1-ru-002" and ev["checklist_version"] == 1
    assert len(ev["criteria"]) == 8
    quoted = 0
    for c in ev["criteria"]:
        for e in c["evidence"]:
            t = CONV["transcript"][e["turn_index"]]
            assert (e["quote"], e["speaker"], e["timestamp"]) == (t["text"], t["speaker"], t["timestamp"])
            quoted += 1
    assert quoted > 0
    na = [c for c in ev["criteria"] if c["answer"] == "na"]
    assert len(na) == 1 and na[0]["criterion_id"] == "needs"
    assert na[0]["share"] is None and na[0]["points"] is None
    assert na[0]["evidence"] == [] and na[0]["na_reason"] and na[0]["checked_range"] == {"from_turn": 0, "to_turn": 3}
    assert ev["gross_error"]["flag"] is False

    again = client.get("/api/evaluations/p1-ru-002")
    assert again.status_code == 200 and again.json() == ev


def test_has_evaluation_flag_in_list(client):
    assert client.get("/api/conversations?group=dev").json()[0]["has_evaluation"] is False
    client.post("/api/evaluate", json={"conversation_id": "p1-ru-002"})
    assert client.get("/api/conversations?group=dev").json()[0]["has_evaluation"] is True


def test_unknown_conversation_404(client):
    r = client.post("/api/evaluate", json={"conversation_id": "nope"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "conversation_not_found"
    r = client.get("/api/evaluations/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "evaluation_not_found"


def test_evaluate_bad_body_422(client):
    assert client.post("/api/evaluate", json={}).status_code == 422
    assert client.post("/api/evaluate", json=[1]).status_code == 422


def test_added_criterion_appears_in_result(client):
    cl = client.get("/api/checklist").json()
    cl["criteria"].append({
        "id": "extra", "name": "Новый", "description": "d", "type": "binary", "scale": None,
        "weight": 5, "na_allowed": False, "na_condition": None, "section": "flow",
    })
    assert client.put("/api/checklist", json=cl).status_code == 200
    ev = client.post("/api/evaluate", json={"conversation_id": "p1-ru-002"}).json()
    assert "extra" in [c["criterion_id"] for c in ev["criteria"]]
    assert ev["checklist_version"] == 2


def test_path_traversal_id_cannot_escape(client, tmp_path):
    assert client.get("/api/evaluations/..%2F..%2Fchecklist").status_code == 404
