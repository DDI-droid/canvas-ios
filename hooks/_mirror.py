"""Shared helper for the Claude Code -> canvas mirror hooks. Never raises."""
import json
import os
import urllib.request

CANVAS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_PATH = os.path.join(CANVAS_DIR, "data", "token.txt")
BASE = os.environ.get("CANVAS_URL", "http://127.0.0.1:8765")


def post_mirror(role: str, text: str, timeout: float = 2.0) -> bool:
    text = (text or "").strip()
    if not text:
        return False
    try:
        with open(TOKEN_PATH, encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        return False  # canvas never set up
    body = json.dumps({"role": role, "text": text}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        BASE + "/api/mirror",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "X-Canvas-Key": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False  # server not running: silently skip


def read_stdin_json() -> dict:
    import sys
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}
