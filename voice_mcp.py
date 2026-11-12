"""Tools for the voice talker (a tiny stdio MCP server, started by Claude Code itself).

The talker has two audiences, and each tool reaches one of them:
  the user        speak(text)                    say words out loud on the iPad
  the main agent  hand_off(say, task)            give real work to the main Claude Code agent
                  add_to_task(say, text)         the main agent is busy and the user added to it
                  ask_main_agent(say, question)  a question only the main agent can answer
  the talker      look_at_board(), read_chat(count), dismiss()
Each tool that sends to the main agent also carries `say`: the words the user hears while it's
sent. Telling the user and doing it are one call, so the talker can't say "I've asked it" by
speaking alone (it did, 2026-11-12: it spoke "Checking with the main agent..." and sent nothing).
The talker's plain text is private: nobody hears or sees it.

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
            "Say something out loud to the USER through the iPad speaker. This is the ONLY way the "
            "user hears an answer from you; anything you write outside this tool is private and never "
            "heard. Only the user hears it: the main agent never does, so speaking that you'll ask it, "
            "check with it or pass something on sends nothing (for that, call hand_off, add_to_task or "
            "ask_main_agent; each one says its `say` to the user for you). Talk like a person: short "
            "phrases, short sentences, contractions, no lists, no markdown."
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
            "SENDS a task to the MAIN AGENT: a slower, fully capable Claude Code session on the "
            "user's PC that sees the whole board, draws on it, opens websites and charts on it, runs "
            "code, edits files and does research. Every request to do something goes here, even when "
            "the user doesn't mention the main agent. The user hears your `say` as it's sent, so don't "
            "call speak as well. Its answer comes back to you later as main_agent_reply."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"say": {"type": "string", "description": "A few words the user hears out loud while this is sent, in their terms: what is being done. One short sentence, and all they need to hear about it: you won't speak about it again this turn."}, "task": {"type": "string", "description": "A self-contained task, in the user's words where useful."}},
            "required": ["say", "task"],
        },
    },
    {
        "name": "add_to_task",
        "description": (
            "The main agent is already working on something and the user adds to it: a detail, a "
            "correction, a change of mind, another idea, \"also...\". SENDS their new words to the "
            "MAIN AGENT right away as a follow-up. Use this instead of telling them it's already "
            "being worked on; that would lose what they just said. The user hears your `say` as it's "
            "sent, so don't call speak as well."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"say": {"type": "string", "description": "A few words the user hears out loud while this is sent, in their terms: what is being done. One short sentence, and all they need to hear about it: you won't speak about it again this turn."}, "text": {"type": "string", "description": "What they added, self-contained, in their words where useful."}},
            "required": ["say", "text"],
        },
    },
    {
        "name": "ask_main_agent",
        "description": (
            "SENDS a question to the MAIN AGENT, one only it can answer: what it did, found, changed "
            "or decided, a result, a file's contents. Check the recent chat first (and read_chat). "
            "This call is the only way to ask it: telling the user you're checking does not ask. The "
            "user hears your `say` as it's sent, so don't call speak as well. Its answer comes back to "
            "you as main_agent_reply."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"say": {"type": "string", "description": "A few words the user hears out loud while this is sent, in their terms: what is being done. One short sentence, and all they need to hear about it: you won't speak about it again this turn."}, "question": {"type": "string", "description": "The question, self-contained."}},
            "required": ["say", "question"],
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
            lines.append(f"{who}: {text[:8000]}")  # whole messages: a cut one reads as "the reply got cut off"
    lines = lines[-n:]
    if not lines:
        return [{"type": "text", "text": "The chat is empty."}]
    return [{"type": "text", "text": "The chat, oldest first:\n" + "\n".join(lines)}]


_said_with_send = ""  # the turn in which a send spoke its `say` (talker.py writes the turn to a file)


def _turn() -> str:
    try:
        with open(os.environ.get("CANVAS_TURN_FILE") or "", "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _call(name: str, args: dict) -> tuple[list, bool]:
    global _said_with_send
    if name == "speak":
        if _said_with_send and _said_with_send == _turn():
            # the same rule as talker.py (_TurnState.stream): a send is the last thing spoken in a turn
            return [{"type": "text", "text": "Not spoken. In this turn the user already heard your `say` when you sent to the "
                                             "main agent, and a send is the last thing spoken in a turn. End your turn."}], False
        return [{"type": "text", "text": "Said to the user. Don't repeat it."}], False
    main_field = {"hand_off": "task", "add_to_task": "text", "ask_main_agent": "question"}.get(name)
    if main_field and not str(args.get(main_field) or "").strip():
        # talker.py sends (and speaks `say`) only when there's something to send
        return [{"type": "text", "text": f"Nothing was sent and the user heard nothing: `{main_field}` was empty. Call {name} again with it filled in."}], True
    say = " ".join(str(args.get("say") or "").split())
    if main_field and say:
        _said_with_send = _turn()
    # after a send the turn is done: a second speak would only repeat what they just heard
    done = (f'The user already heard your `say` ("{say}"). That is all they need to hear about it: end your turn now '
            "without calling speak." if say else "The user heard nothing (`say` was empty): tell them in a few words with speak.")
    if name == "hand_off":
        return [{"type": "text", "text": f"Sent to the main agent. {done} Its answer will come to you later as main_agent_reply."}], False
    if name == "add_to_task":
        return [{"type": "text", "text": f"Sent to the main agent as a follow-up. {done}"}], False
    if name == "ask_main_agent":
        return [{"type": "text", "text": f"Asked the main agent. {done} Its answer will come to you as main_agent_reply: don't guess it."}], False
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
