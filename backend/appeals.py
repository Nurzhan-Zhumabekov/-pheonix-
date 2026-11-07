"""Апелляции и решения проверяющего. Формат строго по контракту (CLAUDE.md, «Апелляция»).

Апелляция и решение — два отдельных действия. Итог при смене ответа пересчитывает
scoring_stub (формулу здесь не дублируем).
"""
import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body

import scoring_stub
from checklist import checklist_path, load_checklist, write_json_atomic
from errors import ApiError
from evaluation import _lock as evaluation_lock
from evaluation import evaluation_path, read_evaluation
from organizers import find_conversation

router = APIRouter(prefix="/api")
_lock = threading.Lock()  # выдача id и resolve
ID_RE = re.compile(r"^ap_[1-9][0-9]*$")
CHECKLIST_CHANGED = "Чек-лист изменился, оцените диалог заново"


def appeals_dir() -> Path:
    return checklist_path().parent / "appeals"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _num(appeal_id: str) -> int:
    return int(appeal_id[3:])


def _read(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _all_appeals() -> list[dict]:
    folder = appeals_dir()
    if not folder.exists():
        return []
    files = [p for p in folder.glob("ap_*.json") if ID_RE.match(p.stem)]
    return sorted((_read(p) for p in files), key=lambda a: _num(a["id"]))


def _load_appeal(appeal_id: str) -> dict | None:
    # имя файла строится только из id вида ap_N, выйти из папки нельзя
    if not ID_RE.match(appeal_id):
        return None
    path = appeals_dir() / f"{appeal_id}.json"
    return _read(path) if path.exists() else None


def _save_appeal(appeal: dict) -> None:
    write_json_atomic(appeals_dir() / f"{appeal['id']}.json", appeal)


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _fragment(entry: dict) -> dict | None:
    turns = [e["turn_index"] for e in entry.get("evidence") or [] if isinstance(e.get("turn_index"), int)]
    if turns:
        return {"from_turn": min(turns), "to_turn": max(turns)}
    rng = entry.get("checked_range")
    if isinstance(rng, dict):
        return {"from_turn": rng.get("from_turn"), "to_turn": rng.get("to_turn")}
    return None


# ---------- подача апелляции ----------

@router.post("/appeals")
def create_appeal(body: Any = Body(...)):
    if not isinstance(body, dict):
        raise ApiError(422, "invalid_request", "Тело запроса должно быть объектом")
    conversation_id = _text(body.get("conversation_id"))
    criterion_id = _text(body.get("criterion_id"))
    if conversation_id is None or criterion_id is None:
        raise ApiError(422, "invalid_request", "Нужны непустые поля conversation_id и criterion_id")
    comment = _text(body.get("comment"))
    if comment is None:
        raise ApiError(422, "empty_comment", "Комментарий не может быть пустым")

    if find_conversation(conversation_id) is None:
        raise ApiError(404, "conversation_not_found", "Диалог с таким id не найден")
    ev = read_evaluation(conversation_id)
    if ev is None:
        raise ApiError(409, "evaluation_required", "Сначала оцените диалог, потом можно подать апелляцию")
    entry = next((c for c in ev["criteria"] if c["criterion_id"] == criterion_id), None)
    if entry is None:
        raise ApiError(404, "criterion_not_found", "Этого критерия нет в оценке диалога")

    with _lock:
        existing = _all_appeals()
        if any(
            a["conversation_id"] == conversation_id and a["criterion_id"] == criterion_id and a["status"] == "open"
            for a in existing
        ):
            raise ApiError(409, "appeal_already_open", "По этому критерию уже есть открытая апелляция")
        next_n = max((_num(a["id"]) for a in existing), default=0) + 1
        appeal = {
            "id": f"ap_{next_n}",
            "conversation_id": conversation_id,
            "criterion_id": criterion_id,
            "comment": comment,
            "fragment": _fragment(entry),
            "status": "open",
            "created_at": _now(),
            "original": {"answer": entry["answer"], "points": entry["points"]},
            "decision": None,
            "final": None,
            "total_before": ev["total"],
            "total_after": None,
        }
        _save_appeal(appeal)
    return appeal


@router.get("/appeals")
def list_appeals(conversation_id: str | None = None):
    items = _all_appeals()
    if conversation_id is not None:
        items = [a for a in items if a["conversation_id"] == conversation_id]
    return items


# ---------- решение проверяющего ----------

def _checked_answer(cdef: dict, value: Any) -> Any:
    """Допустимый новый ответ для критерия или ApiError 422."""
    bad = ApiError(422, "invalid_answer", "Недопустимый new_answer для этого критерия")
    if value == "na":
        if cdef["type"] != "flag" and cdef["na_allowed"]:
            return "na"
        raise ApiError(422, "invalid_answer", "Для этого критерия N/A не разрешён")
    if cdef["type"] in ("binary", "flag"):
        if value in ("yes", "no"):
            return value
        raise bad
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        for step in cdef["scale"]:
            if step == value:
                return step
    raise bad


def _recompute(ev: dict, checklist: dict) -> None:
    section_of = {c["id"]: c.get("section") for c in checklist["criteria"]}
    items = [
        {"section": section_of.get(e["criterion_id"]), "weight": e["weight"], "share": e["share"]}
        for e in ev["criteria"]
    ]
    ev["total"], ev["sections"] = scoring_stub.score(items, [s["id"] for s in checklist["sections"]])


def _apply_change(appeal: dict, new_answer: Any, reason: str, cdef: dict, ev: dict, checklist: dict) -> dict:
    entry = next(e for e in ev["criteria"] if e["criterion_id"] == appeal["criterion_id"])
    share = scoring_stub.share_of(cdef["type"], new_answer, cdef.get("scale"))
    entry["answer"] = new_answer
    entry["share"] = share
    entry["points"] = scoring_stub.points_of(entry["weight"], share)
    entry["na_reason"] = reason if new_answer == "na" else None
    if cdef["type"] == "flag":
        ev["gross_error"]["flag"] = new_answer == "yes"
    _recompute(ev, checklist)
    return {"answer": entry["answer"], "points": entry["points"]}


@router.post("/appeals/{appeal_id}/resolve")
def resolve_appeal(appeal_id: str, body: Any = Body(...)):
    with _lock:
        appeal = _load_appeal(appeal_id)
        if appeal is None:
            raise ApiError(404, "appeal_not_found", "Апелляция не найдена")
        if appeal["status"] == "resolved":
            raise ApiError(409, "appeal_already_resolved", "Решение по этой апелляции уже принято")
        if not isinstance(body, dict):
            raise ApiError(422, "invalid_request", "Тело запроса должно быть объектом")
        action = body.get("action")
        if action not in ("confirm", "change"):
            raise ApiError(422, "invalid_action", "action должен быть confirm или change")
        reason = _text(body.get("reason"))
        if reason is None:
            raise ApiError(422, "empty_reason", "Причина решения не может быть пустой")

        if action == "confirm":
            decision = {"action": "confirm", "new_answer": None, "reason": reason, "decided_at": _now()}
            appeal.update(
                status="resolved", decision=decision,
                final=dict(appeal["original"]), total_after=appeal["total_before"],
            )
            _save_appeal(appeal)
            return appeal

        checklist = load_checklist()
        cdef = next((c for c in checklist["criteria"] if c["id"] == appeal["criterion_id"]), None)
        with evaluation_lock:
            ev = read_evaluation(appeal["conversation_id"])
            if ev is None:
                raise ApiError(409, "evaluation_required", "Оценка диалога не найдена, оцените диалог заново")
            has_entry = any(e["criterion_id"] == appeal["criterion_id"] for e in ev["criteria"])
            if cdef is None or not has_entry or ev["checklist_version"] != checklist["version"]:
                raise ApiError(409, "checklist_changed", CHECKLIST_CHANGED)
            new_answer = _checked_answer(cdef, body.get("new_answer"))
            final = _apply_change(appeal, new_answer, reason, cdef, ev, checklist)
            write_json_atomic(evaluation_path(appeal["conversation_id"]), ev)
        appeal.update(
            status="resolved",
            decision={"action": "change", "new_answer": new_answer, "reason": reason, "decided_at": _now()},
            final=final, total_after=ev["total"],
        )
        _save_appeal(appeal)
        return appeal
