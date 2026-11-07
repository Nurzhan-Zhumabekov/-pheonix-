# ВРЕМЕННО: заменить на scoring Нуржана, формулу в других местах не дублировать.
#
# Формула из CLAUDE.md: итог = 100 × Σ(вес × доля) / Σ(вес) по применимым критериям.
# Да = 1, Нет = 0, шкала = значение / максимум шкалы, N/A исключается из обеих сумм.
# Нет применимых критериев с весом: total = None. Округление до 2 знаков, half up.
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from typing import Any


def _frac(x: Any) -> Fraction:
    # Через str, чтобы 0.1 не превращалось в 0.1000000000000000055...
    return Fraction(Decimal(str(x)))


def round_half_up(value: Fraction, digits: int = 2) -> float:
    q = Decimal(1).scaleb(-digits)
    d = Decimal(value.numerator) / Decimal(value.denominator)
    return float(d.quantize(q, rounding=ROUND_HALF_UP))


def share_of(ctype: str, answer: Any, scale: list | None) -> float | None:
    """Доля баллов: None для N/A и для флага (флаг без баллов)."""
    if ctype == "flag" or answer == "na":
        return None
    if answer == "yes":
        return 1.0
    if answer == "no":
        return 0.0
    top = max(scale) if scale else 0  # шкала: значение / максимум
    return float(answer) / top if top > 0 else 0.0


def points_of(weight: float, share: float | None) -> float | None:
    return None if share is None else round_half_up(_frac(weight) * _frac(share))


def _weighted_score(items: list[dict]) -> float | None:
    """items: [{weight, share}]. None, если нет применимых критериев с весом."""
    num = Fraction(0)
    den = Fraction(0)
    for it in items:
        if it["share"] is None or it["weight"] <= 0:
            continue
        num += _frac(it["weight"]) * _frac(it["share"])
        den += _frac(it["weight"])
    if den == 0:
        return None
    return round_half_up(100 * num / den)


def score(items: list[dict], section_ids: list[str]) -> tuple[float | None, list[dict]]:
    """items: [{section, weight, share}] -> (total, [{id, score}])."""
    total = _weighted_score(items)
    sections = [
        {"id": sid, "score": _weighted_score([i for i in items if i.get("section") == sid])}
        for sid in section_ids
    ]
    return total, sections
