from typing import Literal

from fastapi import APIRouter

from errors import ApiError
from evaluation import has_evaluation
from organizers import find_conversation, get_records

router = APIRouter(prefix="/api")


@router.get("/conversations")
def list_conversations(group: Literal["dev", "control"] = "dev"):
    return [
        {
            "conversation_id": r.get("conversation_id"),
            "channel": r.get("channel"),
            "language": r.get("language"),
            "turns_count": len(r.get("transcript") or []),
            "has_evaluation": has_evaluation(r.get("conversation_id")),
        }
        for r in get_records(group)
    ]


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str):
    rec = find_conversation(conversation_id)
    if rec is None:
        raise ApiError(404, "conversation_not_found", "Диалог с таким id не найден")
    return rec  # как пришло от организаторов, метки времени без изменений
