import copy
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import checklist  # noqa: E402
from main import app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Временная папка вместо настоящей storage/
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path))
    return TestClient(app)


@pytest.fixture
def valid(client):
    return client.get("/api/checklist").json()


def test_default_has_8_criteria_and_is_valid(valid):
    assert len(valid["criteria"]) == 8
    assert checklist.validate_checklist(valid) == []


def test_put_valid_changes_weight_and_bumps_version(client, valid):
    changed = copy.deepcopy(valid)
    changed["criteria"][0]["weight"] = 12
    changed["version"] = 999  # присланную версию сервер игнорирует
    r = client.put("/api/checklist", json=changed)
    assert r.status_code == 200
    assert r.json()["version"] == valid["version"] + 1
    again = client.get("/api/checklist").json()
    assert again["criteria"][0]["weight"] == 12
    assert again["version"] == valid["version"] + 1


def _break(mutator):
    def make(valid):
        bad = copy.deepcopy(valid)
        mutator(bad)
        return bad
    return make


BREAKS = {
    "bad_type": lambda d: d["criteria"][0].update(type="text"),
    "scale_empty": lambda d: d["criteria"][3].update(scale=[]),
    "scale_not_numbers": lambda d: d["criteria"][3].update(scale=[0, "a"]),
    "scale_missing": lambda d: d["criteria"][3].update(scale=None),
    "weight_negative": lambda d: d["criteria"][0].update(weight=-1),
    "weight_not_number": lambda d: d["criteria"][0].update(weight="10"),
    "flag_weight_nonzero": lambda d: d["criteria"][7].update(weight=5),
    "id_duplicate": lambda d: d["criteria"][1].update(id=d["criteria"][0]["id"]),
    "id_empty": lambda d: d["criteria"][0].update(id=" "),
    "section_unknown": lambda d: d["criteria"][0].update(section="nope"),
    "na_allowed_not_bool": lambda d: d["criteria"][0].update(na_allowed="yes"),
    "na_condition_empty": lambda d: d["criteria"][1].update(na_condition=""),
}


@pytest.mark.parametrize("name", list(BREAKS))
def test_put_invalid_gives_422_in_contract_format(client, valid, name):
    bad = copy.deepcopy(valid)
    BREAKS[name](bad)
    r = client.put("/api/checklist", json=bad)
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "invalid_checklist"
    assert err["message"]
    # неудачный PUT ничего не меняет
    assert client.get("/api/checklist").json()["version"] == valid["version"]


def test_section_null_is_allowed(client, valid):
    ok = copy.deepcopy(valid)
    ok["criteria"][0]["section"] = None
    assert client.put("/api/checklist", json=ok).status_code == 200


def test_put_not_an_object_gives_422(client):
    assert client.put("/api/checklist", json=[1, 2]).status_code == 422


def test_atomic_write_leaves_no_temp_files(client, valid, tmp_path):
    client.put("/api/checklist", json=valid)
    assert [p.name for p in tmp_path.iterdir()] == ["checklist.json"]
    json.loads((tmp_path / "checklist.json").read_text(encoding="utf-8"))
