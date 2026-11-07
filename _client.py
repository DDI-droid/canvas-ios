"""Shared stdlib client for the canvas helper CLIs (say.py, status.py, draw.py)."""
from __future__ import annotations

import json
import locale
import os
import sys
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
TOKEN_FILE = os.path.join(DATA_DIR, "token.txt")
SERVER_INFO = os.path.join(DATA_DIR, "server.json")


def setup_utf8() -> None:
    """Make stdout/stderr UTF-8 so printing math symbols / emoji never crashes on Windows."""
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def die(msg: str, code: int = 1):
    print(f"error: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def read_token() -> str:
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            tok = f.read().strip()
    except FileNotFoundError:
        die(f"{TOKEN_FILE} not found - start the server once (python canvas/server.py)")
    if not tok:
        die(f"{TOKEN_FILE} is empty")
    return tok


def base_url(port: int | None = None) -> str:
    env = os.environ.get("CANVAS_URL")
    if env:
        return env.rstrip("/")
    if port is None and os.environ.get("CANVAS_PORT"):
        port = int(os.environ["CANVAS_PORT"])
    if port is None:
        try:
            with open(SERVER_INFO, "r", encoding="utf-8") as f:
                port = int(json.load(f).get("port") or 8765)
        except Exception:
            port = 8765
    return f"http://127.0.0.1:{port}"


def call(method: str, path: str, payload=None, port: int | None = None, timeout: float = 30):
    url = base_url(port) + path
    data = None
    headers = {"X-Canvas-Key": read_token(), "Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    # never route 127.0.0.1 through a system/corporate proxy
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            body = json.loads(body).get("error", body)
        except Exception:
            pass
        die(f"HTTP {e.code} from {path}: {body}")
    except urllib.error.URLError as e:
        die(f"cannot reach canvas server at {base_url(port)} ({e.reason}). "
            "Is `python canvas/server.py` running?")


def decode_bytes(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode(locale.getpreferredencoding(False) or "utf-8", errors="replace")


def read_stdin() -> str:
    return decode_bytes(sys.stdin.buffer.read())


def read_file(path: str) -> str:
    try:
        with open(path, "rb") as f:
            return decode_bytes(f.read())
    except OSError as e:
        die(f"cannot read {path}: {e}")
