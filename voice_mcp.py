"""Tools for the voice talker (a tiny stdio MCP server, started by Claude Code itself).

The talker's plain text is private: the user only hears what it passes to `speak`.
    speak(text)       say words out loud on the iPad
    look_at_board()   get a picture of the user's current board view
    hand_off(task)    give real work to the main Claude Code agent
    dismiss()         what it heard wasn't meant for it: the page erases the user's words

The canvas server (server.py) watches the talker's output stream and acts on `speak` and
`hand_off` as the tool input streams in, so speech starts before this process is even
called. Here those two only acknowledge. `look_at_board` fetches the snapshot the page
uploaded (GET /api/talk/board, which waits for it).
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CANVAS_URL = os.environ.get("CANVAS_URL", "http://127.0.0.1:8765").rstrip("/")
CANVAS_SESSION = os.environ.get("CANVAS_SESSION", "main")

TOOLS = [
    {
        "name": "speak",
        "description": (
            "Say something out loud to the user through the iPad speaker. This is the ONLY way "
            "the user hears you; anything you write outside this tool is private and never heard. "
            "Talk like a person: short phrases, short sentences, contractions, no lists, no markdown."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "The exact words to say."}},
            "required": ["text"],
        },
    },
    {
        "name": "look_at_board",
        "description": (
            "See the user's canvas: returns a picture of what is on their screen right now. Use it "
            "when they refer to the board (\"this\", \"here\", \"what I drew\", \"is that right\")."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "hand_off",
        "description": (
            "Give a task to the main agent: a slower, fully capable Claude Code session on the "
            "user's PC that sees the whole board, draws on it, runs code, edits files and does "
            "research. Its answer comes back to you later as main_agent_reply."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"task": {"type": "string", "description": "A self-contained task, in the user's words where useful."}},
            "required": ["task"],
        },
    },
    {
        "name": "dismiss",
        "description": (
            "What you heard wasn't meant for you: TV, someone else talking, background noise, your "
            "own echo, a stray word. The user's words are erased. (If they're just mid-thought, "
            "don't call this: end your turn without any tool and their words are kept.)"
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _token() -> str:
    try:
        with open(os.path.join(BASE_DIR, "data", "token.txt"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _look() -> list:
    req = urllib.request.Request(CANVAS_URL + "/api/talk/board?wait=9",
                                 headers={"X-Canvas-Key": _token(), "X-Canvas-Session": CANVAS_SESSION})
    try:
        with urllib.request.urlopen(req, timeout=12) as res:
            data = json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return [{"type": "text", "text": f"The board picture didn't arrive ({exc}). Say you couldn't see it."}]
    return [
        {"type": "image", "data": data["data"], "mimeType": data["media_type"]},
        {"type": "text", "text": "This is the user's current board view."},
    ]


def _call(name: str, args: dict) -> tuple[list, bool]:
    if name == "speak":
        return [{"type": "text", "text": "Said. Don't repeat it. End your turn unless you need another tool."}], False
    if name == "hand_off":
        return [{"type": "text", "text": "Handed to the main agent. Its answer will come to you as main_agent_reply."}], False
    if name == "look_at_board":
        return _look(), False
    if name == "dismiss":
        return [{"type": "text", "text": "Dismissed. End your turn."}], False
    return [{"type": "text", "text": f"unknown tool {name}"}], True


def main() -> None:
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if "id" not in msg:  # notification
            continue
        method, mid = msg.get("method"), msg["id"]
        params = msg.get("params") or {}
        if method == "initialize":
            result = {
                "protocolVersion": params.get("protocolVersion") or "2025-06-18",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "voice", "version": "1.0"},
            }
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            content, is_error = _call(params.get("name", ""), params.get("arguments") or {})
            result = {"content": content, "isError": is_error}
        elif method == "ping":
            result = {}
        else:
            out.write(json.dumps({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}}) + "\n")
            out.flush()
            continue
        out.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": result}) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
