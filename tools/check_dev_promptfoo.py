"""Check a saved Phoenix DEV export with Promptfoo's local echo provider."""

import argparse
import base64
from collections import Counter
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from cqa_results import BY_OUTPUT_ID, EXPECTED_CHANNELS, clean_text, reference_total


PROMPTFOO = "promptfoo@0.125.1"
DEV_ID = re.compile(r"p([14])-(en|kz|ru)-[0-9]{3}")
CHANNELS = {"1": "agent chat", "4": "voice call"}


def reject_duplicate_keys(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("JSON contains duplicate keys.")
    return result


def read_dev_export(path):
    document = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicate_keys)
    if not isinstance(document, dict) or set(document) != {"schema_version", "team_name", "model", "results"}:
        raise ValueError("Expected the four fields of Appendix JSON 1.0.")
    if (document["schema_version"], document["team_name"], document["model"]) != (
        "1.0", "Phoenix", {"mode": "external_api", "name": "gpt-6.1-terra"}
    ):
        raise ValueError("Expected a Phoenix JSON 1.0 export from Terra.")
    rows = document["results"]
    expected = EXPECTED_CHANNELS["dev"]
    if not isinstance(rows, list) or len(rows) != sum(expected.values()):
        raise ValueError("Expected 65 DEV results.")

    seen = set()
    languages = Counter()
    channels = Counter()
    for row in rows:
        conversation_id = row.get("conversation_id") if isinstance(row, dict) else None
        match = DEV_ID.fullmatch(conversation_id) if isinstance(conversation_id, str) else None
        if not match or conversation_id in seen:
            raise ValueError("DEV IDs must match the dataset naming format and be unique.")
        seen.add(conversation_id)
        channels[CHANNELS[match[1]]] += 1
        languages[match[2].upper()] += 1
    if channels != expected:
        raise ValueError("Expected 60 chats and 5 calls.")
    return rows, languages


def row_problem(row):
    if set(row) != {"conversation_id", "status", "criteria", "score"} or row["status"] != "ok":
        return "Expected a successful result with criteria and a score."
    criteria = row["criteria"]
    if not isinstance(criteria, list) or any(not isinstance(item, dict) for item in criteria):
        return "Expected an array of criterion objects."
    if [item.get("criterion_id") for item in criteria] != list(BY_OUTPUT_ID):
        return "Expected the eight Appendix criteria once, in export order."

    for item in criteria:
        criterion = item["criterion_id"]
        if set(item) != {"criterion_id", "value", "rationale", "evidence_turns"}:
            return f"{criterion}: unexpected criterion fields."
        _, kind, _, allow_na, steps = BY_OUTPUT_ID[criterion]
        value = item["value"]
        valid_value = (
            (value is None and allow_na)
            or (type(value) is bool and kind in ("binary", "flag"))
            or (type(value) is int and kind == "scale" and value in steps)
        )
        if not valid_value:
            return f"{criterion}: value does not match the allowed type or scale."
        rationale = item["rationale"]
        if not isinstance(rationale, str) or not rationale.strip() or clean_text(rationale) != rationale:
            return f"{criterion}: rationale is empty or has unredacted content."
        turns = item["evidence_turns"]
        if (not isinstance(turns, list) or (value is not None and not turns)
                or any(type(turn) is not int or turn < 1 for turn in turns)
                or turns != sorted(set(turns))):
            return f"{criterion}: invalid one-based evidence indices."

    score = row["score"]
    if not isinstance(score, dict) or set(score) != {"final_score", "critical_flag"}:
        return "Expected final_score and critical_flag."
    if score["critical_flag"] is not criteria[-1]["value"]:
        return "Critical flag differs from the critical criterion."
    total = score["final_score"]
    if type(total) not in (int, float) or Decimal(str(total)) != reference_total(criteria):
        return "Final score differs from the Appendix calculation."
    return None


def get_assert(output, _context):
    """Promptfoo Python assertion on one saved result."""
    problem = row_problem(json.loads(base64.b64decode(output, validate=True)))
    return {"pass": problem is None, "score": int(problem is None), "reason": problem or "Valid DEV result"}


def run_promptfoo(rows):
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise ValueError("npm is required to run the pinned Promptfoo CLI.")

    with tempfile.TemporaryDirectory(prefix="phoenix-promptfoo-") as directory:
        scratch = Path(directory)
        assertion = scratch / Path(__file__).name
        shutil.copyfile(__file__, assertion)
        (scratch / "empty-env").touch()
        (scratch / "assertions.json").write_text(
            json.dumps([{"type": "python", "value": f"file://{assertion.name}"}]), encoding="utf-8"
        )
        # Echo renders a template variable. Keep the export opaque to that renderer.
        outputs = [base64.b64encode(json.dumps(row).encode()).decode("ascii") for row in rows]
        (scratch / "outputs.json").write_text(json.dumps(outputs), encoding="utf-8")

        env = {
            key: value for key, value in os.environ.items()
            if key.upper() in {
                "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
                "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
            }
        }
        env.update(
            DOTENV_PATH=str(scratch / "empty-env"),
            PROMPTFOO_CONFIG_DIR=str(scratch),
            PROMPTFOO_DISABLE_TELEMETRY="1",
            PROMPTFOO_DISABLE_UPDATE="1",
            PROMPTFOO_DISABLE_REMOTE_GENERATION="true",
            PROMPTFOO_DISABLE_SHARING="1",
            PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS="true",
            PROMPTFOO_LOG_DIR=str(scratch),
            PROMPTFOO_DISABLE_DEBUG_LOG="1",
            PROMPTFOO_DISABLE_ERROR_LOG="1",
            PROMPTFOO_SELF_HOSTED="1",
            PROMPTFOO_PYTHON=sys.executable,
            PYTHONPATH=str(Path(__file__).resolve().parent),
            PYTHONDONTWRITEBYTECODE="1",
        )
        completed = subprocess.run(
            [npm, "exec", "--offline", "--ignore-scripts", "--yes", "--package", PROMPTFOO, "--", "promptfoo",
             "eval", "--assertions", "assertions.json", "--model-outputs", "outputs.json",
             "--no-write", "--no-cache", "--no-share", "--no-table", "--no-progress-bar",
             "--safe-mode", "--output", "report.json"],
            cwd=scratch, env=env, capture_output=True, timeout=180,
        )
        report_path = scratch / "report.json"
        if not report_path.is_file():
            raise ValueError(
                f"Promptfoo did not generate a report (exit {completed.returncode}). "
                f"Cache {PROMPTFOO} with npm exec from a temporary directory and retry."
            )
        report = json.loads(report_path.read_text(encoding="utf-8"))
        stats = report["results"]["stats"]
        print(f"Promptfoo {PROMPTFOO.split('@')[1]}: {stats['successes']}/{len(rows)} passed, "
              f"{stats['failures']} failed, {stats['errors']} errors.")
        passed = completed.returncode == 0 and stats["successes"] == len(rows)
        if not passed:
            for index, row in enumerate(rows, 1):
                if problem := row_problem(row):
                    print(f"Row {index}: {problem}", file=sys.stderr)
        return passed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Path to the saved Terra DEV results.json")
    args = parser.parse_args()
    try:
        rows, languages = read_dev_export(args.input)
        if not run_promptfoo(rows):
            return 1
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(f"DEV check failed: {error}", file=sys.stderr)
        return 1

    breakdown = ", ".join(f"{language} {count}" for language, count in sorted(languages.items()))
    flagged = sum(row["score"]["critical_flag"] for row in rows)
    print(f"Phoenix / Terra: 60 chats + 5 calls ({breakdown}); "
          f"{len(rows) * len(BY_OUTPUT_ID)} criteria, {flagged} critical flags.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
