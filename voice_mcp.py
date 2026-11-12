"""Tools for the voice talker (a tiny stdio MCP server, started by Claude Code itself).

The talker's plain text is private: the user only hears what it passes to `speak`.
    speak(text)       say words out loud on the iPad
    look_at_board()   get a picture of the user's current board view
    hand_off(task)    give real work to the main Claude Code agent
    add_to_task(text) the main agent is busy and the user added to it: send it on now
    ask_main_agent(q) a question only the main agent can answer
    read_chat(count)  more of the chat than the few lines each turn shows
    dismiss()         what it heard wasn't meant for it: the page erases the user's words

The canvas server (server.py) watches the talker's output stream and acts on `speak`,
`hand_off`, `add_to_task` and `ask_main_agent` as the tool input streams in, so speech starts
before this process is even called. Here those only acknowledge. `look_at_board` fetches the
snapshot the page uploaded (GET /api/talk/board, which waits for it); `read_chat` reads
GET /api/conversation.
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
            "user's PC that sees the whole board, draws on it, opens websites and charts on it, runs "
            "code, edits files and does research. Every request to do something goes here, even when "
            "the user doesn't mention the main agent. Its answer comes back to you later as "
            "main_agent_reply."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"task": {"type": "string", "description": "A self-contained task, in the user's words where useful."}},
            "required": ["task"],
        },
    },
    {
        "name": "add_to_task",
        "description": (
            "The main agent is already working on something and the user adds to it: a detail, a "
            "correction, a change of mind, another idea, \"also...\". Sends their new words to the "
            "main agent right away as a follow-up. Use this instead of telling them it's already "
            "being worked on; that would lose what they just said."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "What they added, self-contained, in their words where useful."}},
            "required": ["text"],
        },
    },
    {
        "name": "ask_main_agent",
        "description": (
            "Ask the main agent a question only it can answer: what it did, found, changed or "
            "decided, a result, a file's contents. Check the recent chat first (and read_chat). "
            "Its answer comes back to you as main_agent_reply."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"question": {"type": "string", "description": "The question, self-contained."}},
            "required": ["question"],
        },
    },
    {
        "name": "read_chat",
        "description": (
            "Read more of the chat between the user and the main agent (you're shown only the last "
            "few lines). Use it when they refer to something said earlier that you don't have."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"count": {"type": "integer", "description": "How many recent messages (default 10, at most 30)."}},
        },
    },
    {
        "name": "write_on_board",
        "description": (
            "Write a short note on the user's board, at the top right of what they're looking at: a "
            "formula, a key term, or up to three short lines (separate lines with \" / \"). Plain text "
            "and symbols (x², √, ≤, ×); no LaTeX. For diagrams or marking up their work, hand_off instead."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "The note, at most ~200 characters."}},
            "required": ["text"],
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
        data_dir = os.environ.get("CANVAS_DATA") or os.path.join(BASE_DIR, "data")
        with open(os.path.join(data_dir, "token.txt"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _open_website(url: str) -> list:
    body = json.dumps({"url": url}).encode("utf-8")
    req = urllib.request.Request(CANVAS_URL + "/api/browser", data=body, method="POST", headers={
        "X-Canvas-Key": _token(), "X-Canvas-Session": CANVAS_SESSION, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            res.read()
    except urllib.error.HTTPError as exc:
        return [{"type": "text", "text": f"It didn't open ({exc.read().decode('utf-8', 'replace')[:160]}). Tell the user briefly."}]
    except (urllib.error.URLError, OSError) as exc:
        return [{"type": "text", "text": f"It didn't open ({exc}). Tell the user briefly."}]
    return [{"type": "text", "text": "It's on the board now as a browser card. Say so in a few words."}]


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


def _read_chat(count) -> list:
    try:
        n = max(1, min(30, int(count or 10)))
    except (TypeError, ValueError):
        n = 10
    req = urllib.request.Request(CANVAS_URL + f"/api/conversation?limit={n * 3}",
                                 headers={"X-Canvas-Key": _token(), "X-Canvas-Session": CANVAS_SESSION})
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            conv = json.loads(res.read().decode("utf-8")).get("conversation") or []
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return [{"type": "text", "text": f"The chat didn't load ({exc}). Go on without it."}]
    lines = []
    for e in conv:
        if not isinstance(e, dict) or e.get("kind") == "progress" or e.get("source") == "talker":
            continue
        who = "user" if e.get("role") == "user" else "main agent"
        text = " ".join(str(e.get("text") or "").split())
        if text:
            lines.append(f"{who}: {text[:900]}")
    lines = lines[-n:]
    if not lines:
        return [{"type": "text", "text": "The chat is empty."}]
    return [{"type": "text", "text": "The chat, oldest first:\n" + "\n".join(lines)}]


def _call(name: str, args: dict) -> tuple[list, bool]:
    if name == "speak":
        return [{"type": "text", "text": "Said. Don't repeat it. End your turn unless you need another tool."}], False
    if name == "hand_off":
        return [{"type": "text", "text": "Handed to the main agent. Its answer will come to you as main_agent_reply."}], False
    if name == "add_to_task":
        return [{"type": "text", "text": "Sent to the main agent as a follow-up. Tell them in a few words, then end your turn."}], False
    if name == "ask_main_agent":
        return [{"type": "text", "text": "Asked. The answer will come to you as main_agent_reply."}], False
    if name == "read_chat":
        return _read_chat(args.get("count")), False
    if name == "look_at_board":
        return _look(), False
    if name == "write_on_board":
        return [{"type": "text", "text": "Written on the board."}], False
    if name == "dismiss":
        return [{"type": "text", "text": "Dismissed. End your turn."}], False
    if name == "open_website":
        return _open_website(str(args.get("url") or "")), False
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
