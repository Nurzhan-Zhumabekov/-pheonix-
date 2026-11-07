"""Клиент API организаторов. Данные держим только в памяти процесса."""
import json
import os
import socket
import threading
import urllib.error
import urllib.request

from errors import ApiError

# group -> имя переменной окружения с полным адресом (вместе с group_id).
ENV_NAMES = {"dev": "DEV_API_URL", "control": "CONTROL_API_URL"}
TIMEOUT_SEC = 20

_cache: dict[str, list[dict]] = {}
_lock = threading.Lock()


def _fetch(url: str) -> dict:
    # Адрес и ответ нигде не логируем и не кладём в тексты ошибок.
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_SEC) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except socket.timeout:
        raise ApiError(504, "upstream_timeout", "API организаторов не ответил вовремя")
    except urllib.error.HTTPError as e:
        raise ApiError(502, "upstream_http_error", f"API организаторов вернул HTTP {e.code}")
    except urllib.error.URLError as e:
        if isinstance(e.reason, socket.timeout):
            raise ApiError(504, "upstream_timeout", "API организаторов не ответил вовремя")
        raise ApiError(502, "upstream_unreachable", "Не удалось подключиться к API организаторов")
    except (ValueError, UnicodeDecodeError):
        raise ApiError(502, "upstream_bad_response", "API организаторов вернул не JSON")


def _load_group(group: str) -> list[dict]:
    url = os.getenv(ENV_NAMES[group], "").strip()
    if not url:
        raise ApiError(
            503, f"{group}_not_configured",
            f"Не задан {ENV_NAMES[group]} в .env: адрес группы '{group}' неизвестен",
        )
    body = _fetch(url)
    if not isinstance(body, dict) or not body.get("isSuccess"):
        raise ApiError(502, "upstream_error", "API организаторов вернул isSuccess=false")
    records = (body.get("data") or {}).get("records")
    if not isinstance(records, list):
        raise ApiError(502, "upstream_bad_response", "В ответе организаторов нет data.records")
    return records


def get_records(group: str) -> list[dict]:
    """Записи группы: из памяти, а если ещё не загружены, то с API организаторов."""
    with _lock:
        if group not in _cache:
            _cache[group] = _load_group(group)  # при ошибке в кэш не пишем
        return _cache[group]


def find_conversation(conversation_id: str) -> dict | None:
    """Ищем диалог по id сначала в dev, потом в control (если он настроен)."""
    for group in ("dev", "control"):
        if group == "control" and not os.getenv(ENV_NAMES["control"], "").strip():
            continue
        for rec in get_records(group):
            if rec.get("conversation_id") == conversation_id:
                return rec
    return None
