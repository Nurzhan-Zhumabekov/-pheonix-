"""Заглушка оценки (mock: true): ответы заданы простым правилом, настоящего judge нет.

Заменяется на judge Нуржана на шаге 7. Формула итога живёт только в scoring_stub.py.
"""
import json
import threading
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Body

import scoring_stub
from checklist import checklist_path, load_checklist, write_json_atomic
from errors import ApiError
from organizers import find_conversation

router = APIRouter(prefix="/api")
_lock = threading.Lock()

MOCK_NOTE = "Заглушка: ответ задан простым правилом, настоящая оценка модели появится позже."


def evaluation_path(conversation_id: str) -> Path:
    # quote кодирует / и \, так что имя файла не может выйти из папки evaluations/
    name = quote(conversation_id, safe="-_") + ".json"
    return checklist_path().parent / "evaluations" / name


def has_evaluation(conversation_id: str | None) -> bool:
    return bool(conversation_id) and evaluation_path(conversation_id).exists()


def _mock_answers(criteria: list[dict]) -> dict[str, Any]:
    """Фиксированное правило: первый критерий с N/A -> na; Да/Нет по очереди;
    шкала -> вторая ступень сверху; флаг -> нарушения нет."""
    answers: dict[str, Any] = {}
    na_done = False
    binary_n = 0
    for c in criteria:
        if c["type"] == "flag":
            answers[c["id"]] = "no"
        elif c["na_allowed"] and not na_done:
            answers[c["id"]] = "na"
            na_done = True
        elif c["type"] == "scale":
            steps = sorted(c["scale"])
            answers[c["id"]] = steps[-2] if len(steps) > 1 else steps[0]
        else:
            answers[c["id"]] = "yes" if binary_n % 2 == 0 else "no"
            binary_n += 1
    return answers


def _evidence(transcript: list[dict], k: int, role: str) -> list[dict]:
    """Реальная реплика диалога: берём реплики оператора по кругу, иначе любые не system."""
    pool = [i for i, t in enumerate(transcript) if t.get("speaker") == "operator"]
    pool = pool or [i for i, t in enumerate(transcript) if t.get("speaker") != "system"]
    if not pool:
        return []
    idx = pool[k % len(pool)]
    t = transcript[idx]
    return [{
        "turn_index": idx,
        "speaker": t.get("speaker"),
        "timestamp": t.get("timestamp"),
        "quote": t.get("text"),  # дословно
        "role": role,
    }]


def build_mock_evaluation(conv: dict, checklist: dict) -> dict:
    transcript = conv.get("transcript") or []
    criteria = checklist["criteria"]
    answers = _mock_answers(criteria)
    whole = {"from_turn": 0, "to_turn": len(transcript) - 1} if transcript else None

    results, items = [], []
    for k, c in enumerate(criteria):
        ans = answers[c["id"]]
        share = scoring_stub.share_of(c["type"], ans, c.get("scale"))
        points = scoring_stub.points_of(c["weight"], share)
        items.append({"section": c.get("section"), "weight": c["weight"], "share": share})

        if ans == "na":
            evidence, checked, na_reason = [], whole, c.get("na_condition")
        elif ans == "no" and c["type"] != "flag":
            evidence, checked, na_reason = _evidence(transcript, k, "expected_location"), whole, None
        elif c["type"] == "flag":
            evidence, checked, na_reason = [], whole, None
        else:
            evidence, checked, na_reason = _evidence(transcript, k, "supports"), None, None
        results.append({
            "criterion_id": c["id"], "answer": ans, "share": share, "weight": c["weight"],
            "points": points, "explanation": MOCK_NOTE, "evidence": evidence,
            "checked_range": checked, "na_reason": na_reason,
        })

    total, sections = scoring_stub.score(items, [s["id"] for s in checklist["sections"]])
    return {
        "mock": True,
        "conversation_id": conv.get("conversation_id"),
        "channel": conv.get("channel"),
        "language": conv.get("language"),
        "checklist_version": checklist["version"],
        "criteria": results,
        "sections": sections,
        "total": total,
        "gross_error": {"flag": False, "explanation": MOCK_NOTE, "evidence": []},
        "model": {"name": "mock", "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0},
    }


@router.post("/evaluate")
def evaluate(body: Any = Body(...)):
    cid = body.get("conversation_id") if isinstance(body, dict) else None
    if not isinstance(cid, str) or not cid.strip():
        raise ApiError(422, "invalid_request", "Нужно поле conversation_id (непустая строка)")
    conv = find_conversation(cid)
    if conv is None:
        raise ApiError(404, "conversation_not_found", "Диалог с таким id не найден")
    result = build_mock_evaluation(conv, load_checklist())
    with _lock:
        write_json_atomic(evaluation_path(cid), result)
    return result


@router.get("/evaluations/{conversation_id}")
def get_evaluation(conversation_id: str):
    path = evaluation_path(conversation_id)
    if not path.exists():
        raise ApiError(404, "evaluation_not_found", "Для этого диалога оценки ещё нет")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
