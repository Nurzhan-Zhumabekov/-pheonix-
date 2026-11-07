import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body

from errors import ApiError

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATH = REPO_ROOT / "config" / "default_checklist.json"
VALID_TYPES = ("binary", "scale", "flag")

router = APIRouter(prefix="/api")
_lock = threading.Lock()


def checklist_path() -> Path:
    """storage/checklist.json; STORAGE_DIR читаем при каждом вызове (удобно для тестов)."""
    storage = Path(os.getenv("STORAGE_DIR", "").strip() or "storage")
    if not storage.is_absolute():
        storage = REPO_ROOT / storage
    return storage / "checklist.json"


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _nonempty_str(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ""


def validate_checklist(data: Any) -> list[str]:
    """Возвращает список понятных ошибок; пустой список = чек-лист корректен."""
    if not isinstance(data, dict):
        return ["Чек-лист должен быть JSON-объектом"]
    errors: list[str] = []

    sections = data.get("sections")
    section_ids: set[str] = set()
    if not isinstance(sections, list):
        errors.append("Поле sections должно быть списком")
    else:
        for i, s in enumerate(sections):
            if not isinstance(s, dict) or not _nonempty_str(s.get("id")) or not _nonempty_str(s.get("name")):
                errors.append(f"Секция №{i + 1}: нужны непустые id и name")
            else:
                section_ids.add(s["id"])

    criteria = data.get("criteria")
    if not isinstance(criteria, list) or not criteria:
        errors.append("Поле criteria должно быть непустым списком")
        return errors

    seen: set[str] = set()
    for i, c in enumerate(criteria):
        if not isinstance(c, dict):
            errors.append(f"Критерий №{i + 1}: должен быть объектом")
            continue
        cid = c.get("id")
        label = f"Критерий '{cid}'" if _nonempty_str(cid) else f"Критерий №{i + 1}"
        if not _nonempty_str(cid):
            errors.append(f"{label}: id должен быть непустой строкой")
        elif cid in seen:
            errors.append(f"{label}: id повторяется, id критериев должны быть уникальны")
        else:
            seen.add(cid)

        ctype = c.get("type")
        if ctype not in VALID_TYPES:
            errors.append(f"{label}: type должен быть binary, scale или flag")
        if ctype == "scale":
            scale = c.get("scale")
            if not isinstance(scale, list) or not scale or not all(_is_number(x) for x in scale):
                errors.append(f"{label}: для type=scale нужен непустой список чисел в scale")

        weight = c.get("weight")
        if not _is_number(weight) or weight < 0:
            errors.append(f"{label}: weight должен быть числом не меньше 0")
        elif ctype == "flag" and weight != 0:
            errors.append(f"{label}: у type=flag weight должен быть 0")

        section = c.get("section")
        if section is not None and (not isinstance(section, str) or section not in section_ids):
            errors.append(f"{label}: section '{section}' не найдена среди sections")

        na_allowed = c.get("na_allowed")
        if not isinstance(na_allowed, bool):
            errors.append(f"{label}: na_allowed должен быть true или false")
        elif na_allowed and not _nonempty_str(c.get("na_condition")):
            errors.append(f"{label}: при na_allowed=true нужен непустой текст na_condition")
    return errors


def _read(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_atomic(path: Path, data: dict) -> None:
    """Пишем во временный файл рядом и переименовываем: файл либо старый, либо новый целиком."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="checklist.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def load_checklist() -> dict:
    """Текущий чек-лист; при первом обращении создаётся из default_checklist.json."""
    with _lock:
        path = checklist_path()
        if not path.exists():
            _write_atomic(path, _read(DEFAULT_PATH))
        return _read(path)


def save_checklist(new: Any) -> dict:
    errors = validate_checklist(new)
    if errors:
        raise ApiError(422, "invalid_checklist", "; ".join(errors))
    with _lock:
        path = checklist_path()
        stored = _read(path) if path.exists() else _read(DEFAULT_PATH)
        # version считает сервер: сохранённая + 1 (присланную игнорируем)
        saved = {**new, "version": stored["version"] + 1}
        _write_atomic(path, saved)
        return saved


@router.get("/checklist")
def get_checklist():
    return load_checklist()


@router.put("/checklist")
def put_checklist(body: Any = Body(...)):
    return save_checklist(body)
