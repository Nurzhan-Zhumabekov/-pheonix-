"""Export Appendix JSON 1.0 from a configured local CQA backend."""

import argparse
import concurrent.futures as futures
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
RUBRIC = {
    # Internal ID: (Appendix ID, type, weight, N/A allowed, scale)
    "contact": ("contact", "binary", 10, False, ()),
    "needs": ("discovery", "binary", 15, True, ()),
    "identification": ("identification", "binary", 20, True, ()),
    "consultation": ("consultation", "scale", 20, True, (0, 5, 10, 15, 20)),
    "empathy": ("empathy", "binary", 15, False, ()),
    "dialog": ("dialogue", "scale", 15, False, (0, 4, 7, 10)),
    "closing": ("closure", "binary", 5, True, ()),
    "gross": ("critical", "flag", 0, False, ()),
}
BY_OUTPUT_ID = {rule[0]: rule for rule in RUBRIC.values()}
EXPECTED_CHANNELS = {"dev": Counter({"agent chat": 60, "voice call": 5}), "prod": Counter({"agent chat": 10})}
COUNTERS = ("calls", "input_tokens", "output_tokens", "cost_usd")
PUBLIC_ERRORS = {
    "judge_error": "Модель не вернула допустимую оценку диалога.",
    "score_error": "Система не смогла рассчитать оценку диалога.",
    "bad_result": "Ответ системы не соответствует формату обязательных критериев.",
    "network_error": "Не удалось получить ответ сервера оценки.",
}
AUTH_OR_CONFIG = re.compile(
    r"\b(?:401|403|429|insufficient[_ ]quota|invalid[_ ]api[_ ]key|"
    r"invalid[_ ]model|model[_ ]not[_ ]found|authentication[_ ]error|"
    r"billing[_ ]hard[_ ]limit|unsupported[_ ]model)\b|"
    r"model.{0,120}(?:does not exist|not available|not supported)",
    re.IGNORECASE,
)
PROVIDER_TRANSPORT = re.compile(
    r"запрос к модели не удался|модель ответила статусом 50[0-4]|"
    r"connection (?:refused|reset)|connection timed out|no route to host",
    re.IGNORECASE,
)
REDACTIONS = [
    r"(?i)\b(?:https?://|www\.)[^\s<>\"»]+",
    r"(?i)\b[\w.+-]+@(?:[\w.-]+\.[a-z]{2,}\b|\[скрыто\])",
    r"(?i)\b(?:[\w-]+\.)+(?:kz|com|net|org|io|ru)\b(?:[/?#][^\s<>\"»]*)?",
    r"(?<!\w)\+?\d(?:[\s().-]*\d){7,}(?!\w)",
    r"(?i)\b(?:bearer|(?:api[-_ ]?)?token|api[-_ ]?key|secret|signature|sig)\s*[:= ]\s*['\"]?[A-Za-z0-9_./%+=-]{6,}['\"]?",
    r"(?i)\b(?:g?sk[-_]|gh[pousr]_|github_pat_|hf_|xox[baprs]-)[A-Za-z0-9_-]{8,}",
    r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
    r"«[^»]*»|“[^”]*”|\"[^\"]+\"",
]


class ExportError(Exception):
    """Safe message suitable for terminal output."""


class BadResult(Exception):
    pass


class ApiError(Exception):
    def __init__(self, code, systemic=False):
        self.code = code
        self.systemic = systemic


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class LocalApi:
    def __init__(self, base_url, timeout):
        url = urlsplit(base_url)
        if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
                or url.username is not None or url.password is not None
                or url.path not in ("", "/") or url.query or url.fragment):
            raise ExportError("Specify an HTTP loopback backend, e.g. http://127.0.0.1:8080")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def request(self, path, payload=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        req = Request(self.base_url + path, data=body, headers={"Content-Type": "application/json"})
        opener = build_opener(ProxyHandler({}), NoRedirect())
        try:
            with opener.open(req, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                with exc:
                    error = json.load(exc).get("error", {})
                code, message = error.get("code"), error.get("message")
            except (ValueError, TypeError, AttributeError, OSError):
                code, message = None, None
            systemic = (
                exc.code in (301, 302, 303, 307, 308, 401, 403, 429)
                or code in ("invalid_checklist", "storage_error", "no_source", "bad_group", "upstream_error")
                or code == "judge_error" and isinstance(message, str) and bool(AUTH_OR_CONFIG.search(message))
                or code not in PUBLIC_ERRORS
            )
            if code == "judge_error" and isinstance(message, str) and PROVIDER_TRANSPORT.search(message):
                code = "network_error"
            raise ApiError(code if code in PUBLIC_ERRORS else "api_failure", systemic) from None
        except (URLError, OSError, HTTPException):
            raise ApiError("network_error") from None
        except (UnicodeError, ValueError):
            raise ApiError("api_failure", systemic=True) from None


def require(condition):
    if not condition:
        raise BadResult


def verify_checklist(checklist):
    try:
        rows = checklist["criteria"]
        criteria = {row["id"]: row for row in rows}
        require(type(checklist["version"]) is int and checklist["version"] > 0)
        require(len(rows) == len(criteria) and criteria.keys() == RUBRIC.keys())
        for key, (_external, kind, weight, na_allowed, steps) in RUBRIC.items():
            row = criteria[key]
            require(row["type"] == kind and type(row["weight"]) in (int, float)
                    and row["weight"] == weight and row["na_allowed"] is na_allowed)
            scale = row.get("scale", [])
            require(all(type(value) in (int, float) for value in scale)
                    and tuple(sorted(scale)) == steps)
    except (BadResult, KeyError, TypeError, AttributeError):
        raise ExportError("Active checklist IDs, types, weights, N/A rules or scales differ from Appendix JSON 1.0") from None


def list_source(api, group, refresh):
    key = "dev" if group == "dev" else "control"
    query = urlencode({"group": key, **({"refresh": "true"} if refresh else {})})
    listing = api.request("/api/conversations?" + query)
    try:
        items = listing["items"]
        require(listing["group"] == key and type(listing["count"]) is int and listing["count"] == len(items))
        ids = [item["conversation_id"] for item in items]
        require(all(isinstance(cid, str) and cid.strip() for cid in ids) and len(set(ids)) == len(ids))
        require(Counter(item["channel"].casefold().strip() for item in items) == EXPECTED_CHANNELS[group])
        require(all(type(item["turns"]) is int and item["turns"] > 0 for item in items))
        return items
    except (BadResult, KeyError, TypeError, AttributeError):
        raise ExportError("Wrong dataset size/channel mix, invalid source IDs, duplicate IDs or empty transcripts") from None


def clean_text(value):
    if not isinstance(value, str):
        raise BadResult
    for pattern in REDACTIONS:
        value = re.sub(pattern, "[скрыто]", value)
    result = " ".join(value.split()).strip()
    if not result:
        raise BadResult
    return result[:1500].rstrip()


def export_value(answer, kind, na_allowed, steps):
    if answer == "na":
        require(na_allowed)
        return None
    if kind == "binary":
        require(answer in ("yes", "no"))
        return answer == "yes"
    require(type(answer) in (int, float) and answer in steps)
    return int(answer)


def evidence_indices(evidence, turns):
    require(isinstance(evidence, list))
    indices = [item["turn_index"] for item in evidence]
    require(all(type(index) is int and 0 <= index < turns for index in indices))
    return sorted({index + 1 for index in indices})


def fallback_evidence(row, turns):
    inspected = row.get("checked_range")
    require(isinstance(inspected, dict))
    lo, hi = inspected["from_turn"], inspected["to_turn"]
    require(type(lo) is int and type(hi) is int and 0 <= lo <= hi < turns)
    return list(range(lo + 1, hi + 2))


def absence_anchors(api, source):
    # For an absent critical violation, inspect speaker roles only. Never copy
    # source text, audio URLs, or metadata to the result.
    row = api.request("/api/conversations/" + quote(source["conversation_id"], safe=""))
    turns = row["transcript"]
    require(row["conversation_id"] == source["conversation_id"] and len(turns) == source["turns"])
    return [i for i, turn in enumerate(turns, 1) if turn["speaker"] == "operator"]


def reference_total(criteria):
    numerator = Decimal(0)
    denominator = 0
    for criterion in criteria:
        _, kind, weight, _, steps = BY_OUTPUT_ID[criterion["criterion_id"]]
        value = criterion["value"]
        if value is None or kind == "flag":
            continue
        fraction = Decimal(value) if kind == "binary" else Decimal(value) / max(steps)
        numerator += weight * fraction
        denominator += weight
    require(denominator > 0)
    return (100 * numerator / denominator).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def transform(api, evaluation, source):
    require(evaluation["conversation_id"] == source["conversation_id"])
    require(evaluation["channel"].casefold().strip() == source["channel"].casefold().strip())
    rows = evaluation["criteria"]
    by_id = {row["criterion_id"]: row for row in rows}
    require(len(rows) == len(by_id) and by_id.keys() == (RUBRIC.keys() - {"gross"}))
    result = []
    turns = source["turns"]
    for key, (external, kind, weight, allowed_na, steps) in RUBRIC.items():
        if kind == "flag":
            row = evaluation["gross_error"]
            value = row["flag"]
            require(type(value) is bool)
            rationale = clean_text(row.get("explanation") or ("Грубое нарушение выявлено." if value else "Грубых нарушений не выявлено."))
            anchors = evidence_indices(row["evidence"], turns)
            if not value and not anchors:
                anchors = absence_anchors(api, source)
            if value:
                require(bool(anchors) and bool(row.get("explanation")))
        else:
            row = by_id[key]
            require(type(row["weight"]) in (int, float) and row["weight"] == weight)
            value = export_value(row["answer"], kind, allowed_na, steps)
            rationale = clean_text(row["na_reason"] if value is None else row["explanation"])
            anchors = evidence_indices(row["evidence"], turns)
            if value is None and not anchors and row.get("checked_range") is not None:
                anchors = fallback_evidence(row, turns)
            if value is not None:
                require(bool(anchors))
        result.append({"criterion_id": external, "value": value, "rationale": rationale, "evidence_turns": anchors})
    total = reference_total(result)
    require(type(evaluation["total"]) in (int, float) and math.isfinite(evaluation["total"]))
    require(Decimal(str(evaluation["total"])) == total)
    return {"conversation_id": source["conversation_id"], "status": "ok", "criteria": result,
            "score": {"final_score": float(total), "critical_flag": result[-1]["value"]}}


def error_row(source, code):
    return {"conversation_id": source["conversation_id"], "status": "error", "criteria": [],
            "score": None, "error": PUBLIC_ERRORS[code]}


def evaluate_one(api, source, model_name, version):
    usage = {}
    confirmed = False
    try:
        evaluation = api.request("/api/evaluate", {"conversation_id": source["conversation_id"]})
        model = evaluation["model"]
        if evaluation["mock"] is not False or model.get("name") != model_name:
            raise ExportError("Backend returned mock data or a different model. No results published.")
        if evaluation["checklist_version"] != version:
            raise ExportError("Checklist version changed during evaluation. No results published.")
        confirmed = True
        for key in COUNTERS:
            value = model.get(key)
            if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                usage[key] = value
        return transform(api, evaluation, source), usage, True
    except ApiError as exc:
        if exc.systemic:
            raise ExportError("Backend or provider configuration failed. No results published.") from None
        return error_row(source, exc.code), usage, confirmed
    except (BadResult, KeyError, TypeError, AttributeError):
        return error_row(source, "bad_result"), usage, confirmed


def json_hash(value):
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".cqa-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as file:
            json.dump(value, file, ensure_ascii=False, indent=2, allow_nan=False)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def valid_checkpoint_row(row, source):
    require(set(row) == {"conversation_id", "status", "criteria", "score"} and row["status"] == "ok")
    require(row["conversation_id"] == source["conversation_id"])
    criteria = row["criteria"]
    require([item["criterion_id"] for item in criteria] == list(BY_OUTPUT_ID))
    for item in criteria:
        require(set(item) == {"criterion_id", "value", "rationale", "evidence_turns"})
        _, kind, _, allowed_na, steps = BY_OUTPUT_ID[item["criterion_id"]]
        value = item["value"]
        require((value is None and allowed_na) or (type(value) is bool and kind in ("binary", "flag"))
                or (type(value) is int and kind == "scale" and value in steps))
        anchors = item["evidence_turns"]
        require(isinstance(anchors, list) and all(type(n) is int and 1 <= n <= source["turns"] for n in anchors)
                and anchors == sorted(set(anchors)))
        require(clean_text(item["rationale"]) == item["rationale"])
    score = row["score"]
    require(set(score) == {"final_score", "critical_flag"} and score["critical_flag"] is criteria[-1]["value"])
    require(type(score["final_score"]) in (int, float)
            and Decimal(str(score["final_score"])) == reference_total(criteria))


def run(args):
    started = time.monotonic()
    if args.resume and args.refresh is True:
        raise ExportError("Resume requires the previously loaded dataset. Omit --refresh.")
    api = LocalApi(args.base_url, args.timeout)
    if api.request("/api/health").get("ok") is not True:
        raise ExportError("Backend health check failed")
    checklist = api.request("/api/checklist")
    verify_checklist(checklist)
    refresh = args.group == "prod" and not args.resume if args.refresh is None else args.refresh
    items = list_source(api, args.group, refresh)
    sources = {item["conversation_id"]: item for item in items}
    signature = json_hash([args.group, args.team_name, args.expected_model, args.model_mode,
                           checklist, sorted((cid, item["channel"], item["turns"]) for cid, item in sources.items())])
    output = (args.output or ROOT / "results" / args.group / "results.json").resolve()
    checkpoint = args.checkpoint.resolve() if args.checkpoint else None
    if args.resume and not checkpoint:
        raise ExportError("--resume requires --checkpoint")
    if checkpoint and (checkpoint == output or checkpoint.is_relative_to(ROOT) or checkpoint.suffix.lower() != ".json"):
        raise ExportError("Keep the checkpoint outside the repository and separate from output")
    if output.is_relative_to(ROOT / "storage") or output.suffix.lower() != ".json":
        raise ExportError("Output must be a JSON file outside backend storage")

    complete = {}
    stats = Counter()
    verified_model = False
    seen_errors = 0
    if checkpoint and checkpoint.exists():
        if not args.resume:
            raise ExportError("Checkpoint exists. Pass --resume or choose a new checkpoint path.")
        try:
            saved = json.loads(checkpoint.read_text(encoding="utf-8"))
            require(saved["signature"] == signature and isinstance(saved["completed"], dict))
            for cid, entry in saved["completed"].items():
                valid_checkpoint_row(entry["result"], sources[cid])
                require(all(key in COUNTERS and type(value) in (int, float) and math.isfinite(value) and value >= 0
                            for key, value in entry["usage"].items()))
                complete[cid] = entry
                stats.update(entry["usage"])
        except (BadResult, ValueError, OSError, KeyError, TypeError, AttributeError):
            raise ExportError("Checkpoint is invalid or belongs to a different dataset, checklist, model or team") from None
    elif args.resume:
        raise ExportError("Checkpoint not found")

    pending = iter(item for item in items if item["conversation_id"] not in complete)
    ok_count = len(complete)

    def remember(row, usage, confirmed):
        nonlocal seen_errors, verified_model, ok_count
        stats.update(usage)
        verified_model |= confirmed
        success = row["status"] == "ok"
        if success:
            ok_count += 1
        transport_error = row.get("error") == PUBLIC_ERRORS["network_error"]
        seen_errors = seen_errors + 1 if not success and (ok_count == 0 or transport_error) else 0
        complete[row["conversation_id"]] = {"result": row, "usage": usage}
        if checkpoint and success:
            write_json(checkpoint, {"signature": signature, "completed": {
                cid: entry for cid, entry in complete.items() if entry["result"]["status"] == "ok"
            }})
        count = len(complete)
        if count == 1 or count % 5 == 0 or count == len(items):
            errors = count - ok_count
            print(f"processed={count}/{len(items)} errors={errors} calls={stats['calls']} "
                  f"tokens_in={stats['input_tokens']} tokens_out={stats['output_tokens']} "
                  f"cost_usd_reported={stats['cost_usd']:.6f} seconds={time.monotonic() - started:.1f}", flush=True)
        if seen_errors >= args.max_consecutive_failures:
            raise ExportError("Consecutive evaluation failures reached the stop threshold. No results published.")

    # Confirm the running model before opening a concurrent queue.
    while (not verified_model or ok_count == 0) and (item := next(pending, None)) is not None:
        remember(*evaluate_one(api, item, args.expected_model, checklist["version"]))
    with futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        active = set()

        def enqueue():
            item = next(pending, None)
            if item is not None:
                active.add(pool.submit(evaluate_one, api, item, args.expected_model, checklist["version"]))

        for _ in range(args.concurrency):
            enqueue()
        while active:
            done, active = futures.wait(active, return_when=futures.FIRST_COMPLETED)
            for task in done:
                remember(*task.result())
            for _ in done:
                enqueue()

    rows = [complete[item["conversation_id"]]["result"] for item in items]
    ok = sum(row["status"] == "ok" for row in rows)
    if not ok:
        raise ExportError("All evaluations failed. No results published.")
    if json_hash(api.request("/api/checklist")) != json_hash(checklist):
        raise ExportError("Checklist changed during evaluation. No results published.")
    export = {"schema_version": "1.0", "team_name": args.team_name,
              "model": {"mode": args.model_mode, "name": args.expected_model}, "results": rows}
    write_json(output, export)
    print(f"done ok={ok} errors={len(rows) - ok} calls={stats['calls']} "
          f"tokens_in={stats['input_tokens']} tokens_out={stats['output_tokens']} "
          f"cost_usd_reported={stats['cost_usd']:.6f} seconds={time.monotonic() - started:.1f}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", choices=EXPECTED_CHANNELS, required=True)
    parser.add_argument("--team-name", default="Phoenix", help="use the registered team name; Phoenix is a default convention")
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument("--expected-model", default="gpt-6-luna")
    parser.add_argument("--model-mode", choices=("local", "external_api", "hybrid"), default="external_api")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--max-consecutive-failures", type=int, default=4)
    parser.add_argument("--refresh", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    args.team_name = args.team_name.strip()
    if (not args.team_name or not args.expected_model.strip() or not 1 <= args.concurrency <= 8
            or not math.isfinite(args.timeout) or args.timeout <= 0 or args.max_consecutive_failures < 2):
        parser.error("Provide nonempty team and model names, concurrency 1–8, positive timeout and stop threshold >= 2")
    try:
        run(args)
    except ExportError as exc:
        sys.exit(f"ERROR: {exc}")
    except ApiError:
        sys.exit("ERROR: Local backend request failed. No results published.")
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        sys.exit("ERROR: Could not read backend metadata or write the export. No results published.")


if __name__ == "__main__":
    main()
