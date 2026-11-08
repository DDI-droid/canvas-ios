"""Claude Code -> canvas chat mirror, shared by the two hooks. Never raises, never prints.

The canvas chat should read like the whole conversation, wherever the user typed. Messages sent
from the canvas reach Claude through `canvas_agent.py wait`, and Claude answers those on the
canvas with `say`. These hooks cover the other way in: a prompt typed in Claude Code (terminal,
VS Code, or the Claude app's view of the same session) and Claude's answer to it.

  - Only a Claude Code session attached to a canvas session mirrors, and only into that session.
    `canvas_agent.py wait/connect` records "Claude session -> canvas session" in
    ~/.canvas_agent/attached.json (keyed by $CLAUDE_CODE_SESSION_ID, which the hooks get as
    session_id). Other Claude Code sessions in the same folder never touch the canvas.
  - Only turns that start with a typed prompt are mirrored. The prompt hook marks the turn; the
    Stop hook mirrors the final answer only for a marked turn. Turns started by a canvas message
    or a finished background task are skipped: Claude answers those on the canvas itself.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HOME = os.path.join(os.path.expanduser("~"), ".canvas_agent")
ATTACHED = os.path.join(HOME, "attached.json")
TURNS = os.path.join(HOME, "mirror")
CANVAS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# prompts that are the harness talking, not the user typing
NOT_TYPED = ("<task-notification>", "[SYSTEM NOTIFICATION", "<system-reminder>")


def read_stdin_json() -> dict:
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def attached_target(claude_id: str):
    """(origin, key, canvas_session) for this Claude Code session, or None if not attached."""
    entry = _read_json(ATTACHED).get(claude_id) if claude_id else None
    if not isinstance(entry, dict) or not entry.get("session"):
        return None
    link = os.environ.get("CANVAS_LINK")
    if link:
        parts = urllib.parse.urlsplit(link)
        key = urllib.parse.parse_qs(parts.query).get("k", [""])[0]
        origin = f"{parts.scheme}://{parts.netloc}"
    else:
        cfg = _read_json(os.path.join(HOME, "config.json"))
        origin, key = cfg.get("origin"), cfg.get("key")
    if not origin or not key:  # same PC as the server, never `connect`ed: use the local token
        try:
            with open(os.path.join(CANVAS_DIR, "data", "token.txt"), encoding="utf-8") as f:
                origin, key = "http://127.0.0.1:8765", f.read().strip()
        except OSError:
            return None
    return origin, key, entry["session"]


def post_mirror(target, role: str, text: str, timeout: float = 4.0) -> bool:
    text = (text or "").strip()
    if not target or not text:
        return False
    origin, key, sid = target
    body = json.dumps({"role": role, "text": text}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(origin + "/api/mirror", data=body, method="POST", headers={
        "Content-Type": "application/json; charset=utf-8", "X-Canvas-Key": key,
        "X-Canvas-Session": sid, "User-Agent": "canvas-mirror/1.0"})
    host = urllib.parse.urlsplit(origin).hostname or ""
    handlers = [urllib.request.ProxyHandler({})] if host in ("127.0.0.1", "localhost", "::1") else []
    try:
        with urllib.request.build_opener(*handlers).open(req, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False  # server down / tunnel gone: skip quietly


def is_typed_prompt(prompt: str) -> bool:
    p = (prompt or "").strip()
    return bool(p) and not p.startswith("/") and not any(m in p[:400] for m in NOT_TYPED)


def _turn_path(claude_id: str) -> str:
    safe = "".join(ch for ch in claude_id if ch.isalnum() or ch in "-_")[:80]
    return os.path.join(TURNS, safe + ".turn")


def mark_turn(claude_id: str) -> None:
    try:
        os.makedirs(TURNS, exist_ok=True)
        with open(_turn_path(claude_id), "w", encoding="utf-8") as f:
            f.write(str(int(time.time())))
    except OSError:
        pass


def take_turn(claude_id: str) -> bool:
    """True once per marked turn (the marker is removed)."""
    try:
        os.remove(_turn_path(claude_id))
        return True
    except OSError:
        return False


def final_text(data: dict) -> str:
    """Claude's final answer for the turn: from the hook input if given, else the transcript tail."""
    text = data.get("last_assistant_message") or ""
    if isinstance(text, dict):
        text = text.get("text", "")
    if text:
        return text
    path = data.get("transcript_path")
    if not path:
        return ""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 3_000_000))  # transcripts get big: the tail is enough
            lines = f.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    parts = []
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        etype = entry.get("type")
        if etype == "user":
            break  # a tool result or the prompt: everything after it is the final answer
        if etype != "assistant":
            continue
        content = (entry.get("message") or {}).get("content")
        if isinstance(content, str):
            parts.append(content)
            continue
        if not isinstance(content, list):
            continue
        texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if any(isinstance(b, dict) and b.get("type") == "tool_use" for b in content):
            if not parts and texts:
                parts.append("\n\n".join(texts))
            break
        if texts:
            parts.append("\n\n".join(texts))
    return "\n\n".join(reversed([p for p in parts if p.strip()]))
