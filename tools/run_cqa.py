"""Run the Claude checkout's evaluation backend and export one CQA dataset."""

import argparse
import getpass
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
MODEL = "gpt-6-luna"
DEFAULT_TEAM = "Phoenix"


def control_url():
    url = os.environ.get("CONTROL_API_URL", "").strip()
    if not url:
        if not sys.stdin.isatty():
            raise RuntimeError("Для PROD откройте терминал и вставьте ссылку по запросу.")
        url = getpass.getpass("Вставьте ссылку на контрольный API: ").strip()
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.fragment:
        raise RuntimeError("Для PROD нужна полная HTTPS-ссылка из объявления организаторов.")
    return url


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(server, base_url):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if server.poll() is not None:
            break
        try:
            with urlopen(f"{base_url}/api/health", timeout=0.5) as response:
                if json.load(response).get("ok") is True:
                    return
        except (URLError, TimeoutError):
            time.sleep(0.15)
    raise RuntimeError("Бэкенд не запустился. Проверьте локальную конфигурацию проекта.")


def run(group, team_name, concurrency, prod_url):
    subprocess.run(
        ["cargo", "build", "--locked", "--manifest-path", str(BACKEND / "Cargo.toml")],
        cwd=ROOT,
        check=True,
    )
    binary_name = "backend.exe" if os.name == "nt" else "backend"
    binary = BACKEND / "target" / "debug" / binary_name
    with tempfile.TemporaryDirectory(prefix="phoenix-cqa-") as run_dir:
        prompts = Path(run_dir) / "prompts"
        prompts.mkdir()
        for name in ("system.txt", "criterion.txt"):
            shutil.copyfile(ROOT / "config" / "prompts" / name, prompts / name)
        port = free_port()
        base_url = f"http://127.0.0.1:{port}"
        env = os.environ.copy()
        env.update(
            PORT=str(port),
            STORAGE_DIR=run_dir,
            PROMPTS_DIR=str(prompts),
            LLM_PROVIDER="openai",
            LLM_MODEL=MODEL,
            LLM_BASE_URL="https://api.openai.com/v1",
            LLM_REASONING_EFFORT="none",
            LLM_VOTES="3",
            LLM_CONCURRENCY="4",
            LLM_PRICE_IN="0.10",
            LLM_PRICE_OUT="0.50",
        )
        if prod_url:
            env["CONTROL_API_URL"] = prod_url
        server = subprocess.Popen(
            [str(binary)], cwd=BACKEND, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            wait_ready(server, base_url)
            cmd = [
                sys.executable, "-B", str(ROOT / "tools" / "cqa_results.py"),
                "--group", group, "--team-name", team_name, "--base-url", base_url,
                "--expected-model", MODEL, "--model-mode", "external_api",
                "--concurrency", str(concurrency), "--refresh",
            ]
            return subprocess.run(cmd, cwd=ROOT, check=False).returncode
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("group", choices=("dev", "prod"))
    parser.add_argument("--team-name", default=DEFAULT_TEAM)
    parser.add_argument("--concurrency", type=int, choices=range(1, 7), default=4)
    args = parser.parse_args()
    try:
        url = control_url() if args.group == "prod" else None
        return run(args.group, args.team_name, args.concurrency, url)
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        message = str(error) if isinstance(error, RuntimeError) else "Не удалось запустить бэкенд или выгрузку."
        print(message, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Прогон прерван.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
