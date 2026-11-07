import copy
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import organizers  # noqa: E402
import scoring_stub  # noqa: E402
from checklist import write_json_atomic  # noqa: E402
from evaluation import evaluation_path  # noqa: E402
from main import app  # noqa: E402

CID = "p1-ru-002"
CONV = {
    "conversation_id": CID,
    "channel": "agent chat",
    "language": "RU",
    "transcript": [
        {"timestamp": "00:01", "speaker": "client", "text": "Здравствуйте"},
        {"timestamp": "00:05", "speaker": "operator", "text": "Добрый день"},
        {"timestamp": "00:20", "speaker": "client", "text": "Помогите"},
        {"timestamp": "00:30", "speaker": "operator", "text": "Готово"},
    ],
    "audio_url": None,
}

# Пример из CLAUDE.md: 1,3,7 Да; 2 N/A; 4=15; 5 Нет; 6=7 -> 71,18
EXAMPLE = {
    "contact": "yes", "needs": "na", "identification": "yes", "consult": 15,
    "empathy": "no", "dialog_management": 7, "closing": "yes", "gross": "no",
}


def ev_entry(cid, answer, c):
    share = scoring_stub.share_of(c["type"], answer, c.get("scale"))
    return {
        "criterion_id": cid, "answer": answer, "share": share, "weight": c["weight"],
        "points": scoring_stub.points_of(c["weight"], share), "explanation": "x",
        "evidence": [], "checked_range": None,
        "na_reason": c["na_condition"] if answer == "na" else None,
    }


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path))
    monkeypatch.delenv("CONTROL_API_URL", raising=False)
    monkeypatch.setitem(organizers._cache, "dev", [copy.deepcopy(CONV)])
    return TestClient(app)


@pytest.fixture
def seeded(client):
    """Сохранённая оценка с примером из CLAUDE.md."""
    checklist = client.get("/api/checklist").json()
    defs = {c["id"]: c for c in checklist["criteria"]}
    entries = [ev_entry(cid, ans, defs[cid]) for cid, ans in EXAMPLE.items()]
    by_id = {e["criterion_id"]: e for e in entries}
    by_id["empathy"]["evidence"] = [
        {"turn_index": 3, "speaker": "operator", "timestamp": "00:30", "quote": "Готово", "role": "expected_location"},
        {"turn_index": 1, "speaker": "operator", "timestamp": "00:05", "quote": "Добрый день", "role": "expected_location"},
    ]
    by_id["contact"]["checked_range"] = {"from_turn": 0, "to_turn": 3}
    items = [{"section": defs[e["criterion_id"]]["section"], "weight": e["weight"], "share": e["share"]} for e in entries]
    total, sections = scoring_stub.score(items, [s["id"] for s in checklist["sections"]])
    ev = {
        "mock": True, "conversation_id": CID, "channel": "agent chat", "language": "RU",
        "checklist_version": checklist["version"], "criteria": entries, "sections": sections, "total": total,
        "gross_error": {"flag": False, "explanation": "x", "evidence": []},
        "model": {"name": "mock", "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0},
    }
    write_json_atomic(evaluation_path(CID), ev)
    assert total == 71.18
    return client


def appeal(client, criterion="empathy", comment="Оператор был вежлив", cid=CID):
    return client.post("/api/appeals", json={"conversation_id": cid, "criterion_id": criterion, "comment": comment})


def resolve(client, aid="ap_1", **body):
    return client.post(f"/api/appeals/{aid}/resolve", json=body)


def code(r):
    return r.json()["error"]["code"]


# ---------- подача ----------

def test_create_appeal_format_and_fragment_from_evidence(seeded):
    r = appeal(seeded)
    assert r.status_code == 200
    a = r.json()
    assert a["id"] == "ap_1" and a["status"] == "open"
    assert a["comment"] == "Оператор был вежлив"
    assert a["fragment"] == {"from_turn": 1, "to_turn": 3}
    assert a["created_at"].endswith("Z") and "T" in a["created_at"]
    assert a["original"] == {"answer": "no", "points": 0.0}
    assert a["total_before"] == 71.18
    assert a["total_after"] is None and a["decision"] is None and a["final"] is None
    assert set(a) == {"id", "conversation_id", "criterion_id", "comment", "fragment", "status", "created_at",
                      "original", "decision", "final", "total_before", "total_after"}


def test_fragment_falls_back_to_checked_range_then_null(seeded):
    assert appeal(seeded, "contact").json()["fragment"] == {"from_turn": 0, "to_turn": 3}
    assert appeal(seeded, "closing").json()["fragment"] is None


def test_ids_increment_and_original_for_na(seeded):
    assert appeal(seeded, "empathy").json()["id"] == "ap_1"
    a2 = appeal(seeded, "needs").json()
    assert a2["id"] == "ap_2" and a2["original"] == {"answer": "na", "points": None}


def test_create_errors(seeded):
    r = appeal(seeded, cid="nope")
    assert (r.status_code, code(r)) == (404, "conversation_not_found")
    r = appeal(seeded, "nope")
    assert (r.status_code, code(r)) == (404, "criterion_not_found")
    r = appeal(seeded, comment="   ")
    assert (r.status_code, code(r)) == (422, "empty_comment")
    assert seeded.post("/api/appeals", json={"conversation_id": CID}).status_code == 422
    assert seeded.post("/api/appeals", json=[1]).status_code == 422
    assert appeal(seeded).status_code == 200
    r = appeal(seeded)
    assert (r.status_code, code(r)) == (409, "appeal_already_open")


def test_create_without_evaluation_409(client):
    r = appeal(client)
    assert (r.status_code, code(r)) == (409, "evaluation_required")


def test_new_appeal_allowed_after_previous_resolved(seeded):
    appeal(seeded)
    assert resolve(seeded, action="confirm", reason="ок").status_code == 200
    assert appeal(seeded).json()["id"] == "ap_2"


def test_list_filter_and_order(seeded):
    appeal(seeded, "empathy")
    appeal(seeded, "contact")
    assert [a["id"] for a in seeded.get("/api/appeals").json()] == ["ap_1", "ap_2"]
    assert [a["id"] for a in seeded.get(f"/api/appeals?conversation_id={CID}").json()] == ["ap_1", "ap_2"]
    assert seeded.get("/api/appeals?conversation_id=other").json() == []


# ---------- решение ----------

def test_confirm_keeps_evaluation_and_total(seeded):
    before = seeded.get(f"/api/evaluations/{CID}").json()
    appeal(seeded)
    r = resolve(seeded, action="confirm", reason="Оценка верна")
    assert r.status_code == 200
    a = r.json()
    assert a["status"] == "resolved" and a["final"] == a["original"]
    assert a["total_after"] == a["total_before"] == 71.18
    assert a["decision"]["action"] == "confirm" and a["decision"]["new_answer"] is None
    assert a["decision"]["reason"] == "Оценка верна" and a["decision"]["decided_at"].endswith("Z")
    assert seeded.get(f"/api/evaluations/{CID}").json() == before


def test_change_recalculates_total_to_88_82(seeded):
    appeal(seeded)  # empathy: Нет
    r = resolve(seeded, action="change", new_answer="yes", reason="Вежливость была")
    assert r.status_code == 200
    a = r.json()
    assert a["original"] == {"answer": "no", "points": 0.0}  # исходные данные остались
    assert a["final"] == {"answer": "yes", "points": 15.0}
    assert a["total_before"] == 71.18 and a["total_after"] == 88.82  # 100 × (60,5 + 15) / 85
    assert a["decision"]["new_answer"] == "yes"
    ev = seeded.get(f"/api/evaluations/{CID}").json()
    assert ev["total"] == 88.82
    emp = next(c for c in ev["criteria"] if c["criterion_id"] == "empathy")
    assert (emp["answer"], emp["share"], emp["points"]) == ("yes", 1.0, 15.0)
    flow = next(s for s in ev["sections"] if s["id"] == "flow")
    assert flow["score"] == 87.14  # (15 + 10,5 + 5) / 35


def test_change_to_na_sets_reason_and_nulls(seeded):
    appeal(seeded, "consult")
    r = resolve(seeded, action="change", new_answer="na", reason="Запрос не был сформулирован")
    assert r.status_code == 200
    ev = seeded.get(f"/api/evaluations/{CID}").json()
    c = next(c for c in ev["criteria"] if c["criterion_id"] == "consult")
    assert c["answer"] == "na" and c["share"] is None and c["points"] is None
    assert c["na_reason"] == "Запрос не был сформулирован"
    assert ev["total"] == 70.0  # 45,5 / 65
    assert r.json()["final"] == {"answer": "na", "points": None}


def test_change_scale_value(seeded):
    appeal(seeded, "dialog_management")
    a = resolve(seeded, action="change", new_answer=10, reason="Всё чётко").json()
    assert a["final"] == {"answer": 10, "points": 15.0}
    assert a["total_after"] == round(100 * (60.5 - 10.5 + 15) / 85, 2)


def test_flag_change_updates_gross_error_but_not_total(seeded):
    appeal(seeded, "gross")
    a = resolve(seeded, action="change", new_answer="yes", reason="Есть оскорбление").json()
    assert a["total_before"] == a["total_after"] == 71.18
    assert a["final"] == {"answer": "yes", "points": None}
    ev = seeded.get(f"/api/evaluations/{CID}").json()
    assert ev["gross_error"]["flag"] is True and ev["total"] == 71.18


@pytest.mark.parametrize("criterion,value", [
    ("empathy", "na"),            # N/A не разрешён
    ("empathy", "maybe"),
    ("empathy", 1),
    ("consult", 12),              # нет в шкале
    ("consult", "yes"),
    ("gross", "na"),
    ("empathy", None),
])
def test_change_invalid_answer_422(seeded, criterion, value):
    appeal(seeded, criterion)
    body = {"action": "change", "reason": "r"}
    if value is not None:
        body["new_answer"] = value
    r = seeded.post("/api/appeals/ap_1/resolve", json=body)
    assert (r.status_code, code(r)) == (422, "invalid_answer")
    assert seeded.get("/api/appeals").json()[0]["status"] == "open"


def test_resolve_errors(seeded):
    r = resolve(seeded, "ap_99", action="confirm", reason="x")
    assert (r.status_code, code(r)) == (404, "appeal_not_found")
    assert resolve(seeded, "ap_0", action="confirm", reason="x").status_code == 404
    appeal(seeded)
    r = resolve(seeded, action="confirm", reason="   ")
    assert (r.status_code, code(r)) == (422, "empty_reason")
    r = resolve(seeded, action="delete", reason="x")
    assert (r.status_code, code(r)) == (422, "invalid_action")
    assert seeded.post("/api/appeals/ap_1/resolve", json=[1]).status_code == 422
    assert resolve(seeded, action="confirm", reason="ок").status_code == 200
    r = resolve(seeded, action="confirm", reason="ещё раз")
    assert (r.status_code, code(r)) == (409, "appeal_already_resolved")
    r = resolve(seeded, action="change", new_answer="yes", reason="ещё раз")
    assert (r.status_code, code(r)) == (409, "appeal_already_resolved")


def test_checklist_change_between_appeal_and_resolve_409(seeded):
    appeal(seeded)
    cl = seeded.get("/api/checklist").json()
    cl["criteria"][0]["weight"] = 11
    assert seeded.put("/api/checklist", json=cl).status_code == 200  # версия 2, оценка осталась по версии 1
    r = resolve(seeded, action="change", new_answer="yes", reason="r")
    assert r.status_code == 409 and code(r) == "checklist_changed"
    assert r.json()["error"]["message"] == "Чек-лист изменился, оцените диалог заново"
    assert seeded.get(f"/api/evaluations/{CID}").json()["total"] == 71.18
    assert seeded.get("/api/appeals").json()[0]["status"] == "open"
    # подтверждение чек-лист не затрагивает
    assert resolve(seeded, action="confirm", reason="ок").status_code == 200


def test_criterion_removed_from_checklist_409(seeded):
    appeal(seeded)
    cl = seeded.get("/api/checklist").json()
    cl["criteria"] = [c for c in cl["criteria"] if c["id"] != "empathy"]
    assert seeded.put("/api/checklist", json=cl).status_code == 200
    r = resolve(seeded, action="change", new_answer="yes", reason="r")
    assert r.status_code == 409 and code(r) == "checklist_changed"


def test_files_are_in_appeals_folder_and_no_temp_left(seeded, tmp_path):
    appeal(seeded)
    names = sorted(p.name for p in (tmp_path / "appeals").iterdir())
    assert names == ["ap_1.json"]
