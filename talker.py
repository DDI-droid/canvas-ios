"""Voice "talker": a fast Claude Haiku session in front of the main Claude Code agent.

Runs Claude Code headless (`claude -p`, stream-json in/out) so it uses the same
subscription login as the main session: no API key. One long-lived process keeps
the conversation and a warm prompt cache.

The talker's plain text is private. It acts only through tools (voice_mcp.py):
    speak(text)       the only thing the user hears
    look_at_board()   a picture of the user's current board view
    hand_off(task)    real work for the main agent
    dismiss()         what it heard wasn't meant for it (noise, side talk): forget it
    (no tool)         the user seems mid-thought: wait, their words are kept
We watch its output stream and act on `speak` / `hand_off` / `look_at_board` as soon as
they appear, through `on_event(kind, data)`:
    ("say", sentence)   each spoken sentence, as soon as it is complete
    ("look", None)      it wants to see the board (the page uploads a snapshot)
    ("handoff", task)   a task for the main agent
    ("dismiss", None)   forget what the user said
A running turn can be cancelled with interrupt() (the user kept talking).
Thinking is on (adaptive, low effort): it thinks briefly only when a turn needs it.
"""
from __future__ import annotations

import glob
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time

MODEL = os.environ.get("CANVAS_TALKER_MODEL", "claude-haiku-5-5")
THINKING = os.environ.get("CANVAS_TALKER_THINKING", "1") != "0"
HERE = os.path.dirname(os.path.abspath(__file__))
TOOL_PREFIX = "mcp__voice__"

SYSTEM_PROMPT = """You are the voice of Claude on the user's iPad canvas: the quick, conversational front of a two-part system. The user talks to you hands-free while they draw and write. Behind you is the main agent: a slower, fully capable Claude Code session on their PC that sees the whole board, draws on it, runs code, edits files, trains models and does research. Its written replies appear in the chat panel; you are the voice.

How turns work:
- Each time the user pauses, you get everything they've said so far as heard: "...". People pause mid-thought all the time. If it sounds unfinished, or they're clearly still going, do nothing: end your turn without using any tool. Their words are kept, and when they go on you get the whole thing again, marked [continued].
- Never fill a pause. Don't say "go on", "I'm listening" or "take your time", and don't ask them to repeat half a sentence. Just wait.
- If it isn't meant for you (TV, radio, a video, someone else talking, background noise, your own echo, a stray word), call dismiss and say nothing at all. News, weather, ads and narration are almost never meant for you.
- Waiting and dismissing are different: an unfinished sentence from the user ("so what I was thinking is that when we") is them mid-thought, so wait (no tool). Never dismiss it, because dismiss erases their words. Dismiss only what clearly isn't them talking to you.
- Answer when they've finished a thought or clearly expect a reply.

You talk only with the speak tool. Plain text you write is private scratch; nobody hears or sees it.

What you receive:
- heard: "..." comes from Apple's speech recognizer, which sometimes mishears. Go with what they most likely meant in context: "hit that load" right after "did it load?" means "it did load", and "what's Cuban" while looking at q in a formula is "what's q then". Never ask them to repeat or say "sorry?". Make your best guess and say it back in a few words, so they can correct you if you're wrong.
- A picture of their screen comes with what they said whenever the board changed since you last saw it. It's exactly what they're looking at: use it to understand "this", "here" and what they're working on. Don't describe the board unless they ask about it.
- [continued]: they kept talking after a pause, and this is the whole thing so far. Answer all of it; they never heard any reply to the earlier part.
- [chat] is the main agent's latest message in the chat. It's background, so you know what they may be answering. Don't read it out unless they ask about it.
- [cut off] means they talked over you; it shows how much you'd said.
- [done] means they tapped to say they've finished: answer now, don't wait.
- main_agent_reply: the main agent finished something. Tell them the gist.
- [status] says whether the main agent is busy.

Tools:
- speak: say something. Usually once per turn.
- look_at_board: a fresh picture of their screen. You usually already have one with their words; call this only if you need a newer look. After looking, always answer with speak, or hand off.
- hand_off: real work for the main agent: checking or explaining work in depth, drawing on the board, code, files, experiments, research, long answers. Write the task so it stands on its own, in their words where useful. Then say in a few words what's being done, in their terms: "Checking your scale math now." Not "Passing that to Claude" or "I've given it to the main agent".
- dismiss: what you heard wasn't for you.
- write_on_board: put a short note on their board (a formula, a key term, up to three short lines; separate lines with " / "). Plain text and symbols like x², √, ≤, ×, θ; no LaTeX. It appears at the top right of what they're looking at. Say a few words too.

The board is shared, and the user wants it used, not just talk: when seeing it written down helps (a formula they asked for, the term you mean, a short list), write it on the board as well as saying it. Anything bigger, like a diagram or marking up their work, is for the main agent: hand it off.
Handle quick back-and-forth yourself: greetings, small talk, clarifying, short facts, "is it done yet?".

How to speak:
- Like a person talking, not like writing. Short phrases. Short sentences. Contractions. One idea at a time.
- Usually one or two short sentences. Go longer only if they ask.
- No lists, markdown, emoji, code or URLs. Say math in words: "five point zero zero five over two fifty-four".
- Start with the point. Never open with "Sure", "Okay", "Got it", "Alright", "Great question" or "So".
- Show you understood: when you answer or act, lead with what you took them to mean, in a few words ("The q in that box? It's the integer..."), then the substance.
- Don't narrate yourself: never "I'm here", "Still here", "I'm listening", "I can hear you", "I heard you", "Sorry, I didn't catch that", or anything about passing messages around. If there's nothing worth saying, say nothing.
- For main_agent_reply: the gist in a sentence or two. If it ends with a question for the user, ask it.
- After speaking, end your turn. Don't write anything else.

The user is learning ML. When tutoring, guide with questions rather than handing over answers, unless they ask for the answer."""

SENTENCE_END_RE = re.compile(r"([.!?…][\"')\]]?)(\s+)")


def find_claude() -> str | None:
    """Locate the Claude Code CLI: $CANVAS_CLAUDE_BIN, PATH, then editor extension folders."""
    env = os.environ.get("CANVAS_CLAUDE_BIN")
    if env and os.path.isfile(env):
        return env
    on_path = shutil.which("claude")
    if on_path:
        return on_path
    home = os.path.expanduser("~")
    found = []
    for editor in (".cursor", ".vscode", ".vscode-insiders", ".windsurf"):
        pattern = os.path.join(home, editor, "extensions", "anthropic.claude-code-*", "resources",
                               "native-binary", "claude*")
        for path in glob.glob(pattern):
            if os.path.isfile(path) and os.path.basename(path).lower() in ("claude", "claude.exe"):
                m = re.search(r"claude-code-(\d+)\.(\d+)\.(\d+)", path)
                ver = tuple(int(x) for x in m.groups()) if m else (0, 0, 0)
                found.append((ver, path))
    return max(found)[1] if found else None


class TalkerError(RuntimeError):
    pass


class Talker:
    def __init__(self, workdir: str, log=print, canvas_url: str = "http://127.0.0.1:8765", session: str = "main"):
        self.workdir = workdir
        self.log = log
        self.canvas_url = canvas_url
        self.session = session  # the canvas session (board) this talker belongs to
        self.lock = threading.Lock()  # one turn at a time
        self.wlock = threading.Lock()  # stdin writes (turns and interrupts)
        self.interrupted = False
        self.proc: subprocess.Popen | None = None
        self.events: "queue.Queue[dict | None]" = queue.Queue()
        os.makedirs(workdir, exist_ok=True)

    # ---- process
    def _alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _spawn(self) -> None:
        exe = find_claude()
        if not exe:
            raise TalkerError("Claude Code CLI not found (set CANVAS_CLAUDE_BIN)")
        mcp = {"mcpServers": {"voice": {
            "command": sys.executable,
            "args": [os.path.join(HERE, "voice_mcp.py")],
            "env": {"CANVAS_URL": self.canvas_url, "CANVAS_SESSION": self.session},
        }}}
        tools = ",".join(TOOL_PREFIX + n for n in ("speak", "look_at_board", "hand_off", "dismiss", "write_on_board"))
        args = [
            exe, "-p",
            "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--include-partial-messages",
            "--model", MODEL,
            "--tools", "",                       # no built-in tools: only the voice tools
            "--mcp-config", json.dumps(mcp), "--strict-mcp-config",
            "--allowedTools", tools,
            "--setting-sources", "",
            "--settings", json.dumps({"alwaysThinkingEnabled": THINKING}),
            "--effort", "low",
            "--no-session-persistence",
            "--system-prompt", SYSTEM_PROMPT,
        ]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.proc = subprocess.Popen(
            args, cwd=self.workdir, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1, creationflags=flags,
        )
        self.events = queue.Queue()
        threading.Thread(target=self._read, args=(self.proc, self.events), daemon=True).start()
        self.log(f"talker [{self.session}]: started {MODEL} with voice tools, thinking={'on' if THINKING else 'off'} (pid {self.proc.pid})")

    @staticmethod
    def _read(proc: subprocess.Popen, out: "queue.Queue[dict | None]") -> None:
        for line in proc.stdout:  # type: ignore[union-attr]
            line = line.strip()
            if not line:
                continue
            try:
                out.put(json.loads(line))
            except ValueError:
                continue
        out.put(None)  # EOF

    def reset(self) -> None:
        with self.lock:
            self._kill()

    def interrupt(self) -> None:
        """Cancel the running turn (Claude Code stream-json control request). Safe to call anytime."""
        if not self._alive():
            return
        self.interrupted = True
        req = {"type": "control_request", "request_id": f"int-{time.time_ns()}", "request": {"subtype": "interrupt"}}
        try:
            with self.wlock:
                self.proc.stdin.write(json.dumps(req) + "\n")  # type: ignore[union-attr]
                self.proc.stdin.flush()  # type: ignore[union-attr]
        except (OSError, ValueError):
            pass

    def _kill(self) -> None:
        """Stop Claude Code and everything it started (its voice-tools MCP server). On Windows,
        killing the parent leaves the children running, holding the session folder open."""
        if self.proc is not None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)],
                               capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try:
                self.proc.kill()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=3)
            except Exception:
                pass
        self.proc = None

    # ---- one turn
    def turn(self, content, on_event=None, timeout: float = 60.0, still_wanted=None) -> dict:
        """Send one user message and follow the talker until its turn ends.

        Returns {mode: say|silent|delegate|look|dismiss|cancelled, task, text, looked, notes, ms, first_ms}.
        `still_wanted()` is checked once the talker is free; False skips the turn (cancelled while queued).
        """
        emit = on_event or (lambda kind, data: None)
        with self.lock:
            if still_wanted is not None and not still_wanted():
                return {"mode": "cancelled", "task": "", "text": "", "looked": False, "notes": "",
                        "ms": 0, "first_ms": None}
            self.interrupted = False
            if not self._alive():
                self._spawn()
            while not self.events.empty():  # drop leftovers from an earlier, abandoned turn
                self.events.get_nowait()
            msg = {"type": "user", "message": {"role": "user", "content": content}}
            t0 = time.perf_counter()
            try:
                with self.wlock:
                    self.proc.stdin.write(json.dumps(msg) + "\n")  # type: ignore[union-attr]
                    self.proc.stdin.flush()  # type: ignore[union-attr]
            except (OSError, ValueError) as exc:
                self._kill()
                raise TalkerError(f"talker process died: {exc}") from exc

            st = _TurnState(emit, t0)
            deadline = t0 + timeout
            while True:
                left = deadline - time.perf_counter()
                if left <= 0:
                    self._kill()
                    raise TalkerError("talker timed out")
                try:
                    ev = self.events.get(timeout=left)
                except queue.Empty:
                    continue
                if ev is None:
                    self._kill()
                    raise TalkerError("talker process exited")
                kind = ev.get("type")
                if kind == "stream_event":
                    st.stream(ev.get("event") or {})
                elif kind == "assistant":
                    st.assistant(ev.get("message") or {})
                elif kind == "result":
                    out = st.summary()
                    if self.interrupted:
                        out["mode"] = "cancelled"
                    elif ev.get("is_error"):
                        raise TalkerError(str(ev.get("result") or ev.get("subtype") or "talker error"))
                    out["ms"] = round((time.perf_counter() - t0) * 1000)
                    return out


class _TurnState:
    """Follows one turn's stream: tool calls as they stream in, sentence by sentence for speak."""

    def __init__(self, emit, t0: float):
        self.emit = emit
        self.t0 = t0
        self.blocks: dict[int, dict] = {}   # content index -> {name, id, buf, field, split}
        self.done_ids: set[str] = set()   # tool calls already acted on
        self.started: set[str] = set()    # tool calls seen in the partial stream
        self.spoken: list[str] = []
        self.tasks: list[str] = []
        self.looked = False
        self.dismissed = False
        self.first_ms: float | None = None
        self.notes = ""                     # its private (unspoken) text, for the log

    # partial messages
    def stream(self, e: dict) -> None:
        t = e.get("type")
        if t == "message_start":
            self.blocks = {}
        elif t == "content_block_start":
            cb = e.get("content_block") or {}
            if cb.get("type") == "tool_use":
                self.started.add(cb.get("id"))
                name = (cb.get("name") or "").removeprefix(TOOL_PREFIX)
                b = {"name": name, "id": cb.get("id"), "buf": "", "field": None, "split": None}
                if name == "speak":
                    b["field"] = _JsonStringField("text")
                    b["split"] = _Sentences(self._say)
                elif name == "look_at_board":
                    self._look(cb.get("id"))
                elif name == "dismiss":
                    self._dismiss()
                self.blocks[e.get("index", -1)] = b
        elif t == "content_block_delta":
            d = e.get("delta") or {}
            if d.get("type") == "text_delta":
                self.notes += d.get("text") or ""
            b = self.blocks.get(e.get("index", -1))
            if b and d.get("type") == "input_json_delta":
                part = d.get("partial_json") or ""
                b["buf"] += part
                if b["field"] is not None:
                    b["split"].feed(b["field"].feed(part))
        elif t == "content_block_stop":
            b = self.blocks.pop(e.get("index", -1), None)
            if b:
                self._finish_block(b)

    # complete assistant messages: a fallback for anything the partial stream missed
    def assistant(self, message: dict) -> None:
        for block in message.get("content") or []:
            bid = block.get("id")
            if block.get("type") != "tool_use" or bid in self.done_ids or bid in self.started:
                continue  # the partial stream already handled (or is handling) this call
            name = (block.get("name") or "").removeprefix(TOOL_PREFIX)
            inp = block.get("input") or {}
            if name == "speak":
                split = _Sentences(self._say)
                split.feed(str(inp.get("text") or ""))
                split.flush()
            elif name == "look_at_board":
                self._look(block.get("id"))
            elif name == "hand_off":
                self._handoff(str(inp.get("task") or ""))
            elif name == "write_on_board":
                self.emit("board_note", str(inp.get("text") or ""))
            elif name == "dismiss":
                self._dismiss()
            self.done_ids.add(block.get("id"))

    def _finish_block(self, b: dict) -> None:
        if b["id"] in self.done_ids:
            return
        self.done_ids.add(b["id"])
        if b["name"] == "speak":
            b["split"].flush()
        elif b["name"] == "hand_off":
            try:
                task = str((json.loads(b["buf"] or "{}") or {}).get("task") or "")
            except ValueError:
                task = ""
            self._handoff(task)
        elif b["name"] == "write_on_board":
            try:
                note = str((json.loads(b["buf"] or "{}") or {}).get("text") or "")
            except ValueError:
                note = ""
            if note.strip():
                self.emit("board_note", note)

    def _say(self, sentence: str) -> None:
        if self.first_ms is None:
            self.first_ms = (time.perf_counter() - self.t0) * 1000
        self.spoken.append(sentence)
        self.emit("say", sentence)

    def _look(self, tool_id) -> None:
        if tool_id in self.done_ids:
            return
        self.done_ids.add(tool_id)
        self.looked = True
        self.emit("look", None)

    def _dismiss(self) -> None:
        if not self.dismissed:
            self.dismissed = True
            self.emit("dismiss", None)

    def _handoff(self, task: str) -> None:
        task = task.strip()
        if task:
            self.tasks.append(task)
            self.emit("handoff", task)

    def summary(self) -> dict:
        task = self.tasks[-1] if self.tasks else ""
        mode = ("delegate" if task else "say" if self.spoken else "dismiss" if self.dismissed
                else "look" if self.looked else "silent")
        return {"mode": mode, "task": task, "text": " ".join(self.spoken).strip(), "looked": self.looked,
                "notes": self.notes.strip()[:1000],
                "first_ms": round(self.first_ms) if self.first_ms is not None else None}


class _JsonStringField:
    """Decode one string field out of JSON that arrives in pieces ({"text": "Hel ... lo"})."""

    ESC = {"n": "\n", "t": " ", "r": "", "b": "", "f": "", '"': '"', "\\": "\\", "/": "/"}

    def __init__(self, key: str):
        self.re = re.compile(r'"%s"\s*:\s*"' % re.escape(key))
        self.buf = ""
        self.pos: int | None = None
        self.closed = False

    def feed(self, part: str) -> str:
        self.buf += part
        if self.pos is None:
            m = self.re.search(self.buf)
            if not m:
                return ""
            self.pos = m.end()
        out = []
        buf = self.buf
        while self.pos < len(buf) and not self.closed:
            c = buf[self.pos]
            if c == '"':
                self.closed = True
                break
            if c != "\\":
                out.append(c)
                self.pos += 1
                continue
            if self.pos + 1 >= len(buf):
                break  # escape split across pieces: wait
            e = buf[self.pos + 1]
            if e != "u":
                out.append(self.ESC.get(e, e))
                self.pos += 2
                continue
            if self.pos + 6 > len(buf):
                break
            code = int(buf[self.pos + 2:self.pos + 6], 16)
            if 0xD800 <= code < 0xDC00:  # surrogate pair: need the low half too
                if self.pos + 12 > len(buf):
                    break
                low = int(buf[self.pos + 8:self.pos + 12], 16)
                out.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
                self.pos += 12
            else:
                out.append(chr(code))
                self.pos += 6
        return "".join(out)


class _Sentences:
    """Split streamed text into sentences; call `out(sentence)` for each one as it completes."""

    def __init__(self, out):
        self.out = out
        self.pending = ""

    def feed(self, text: str) -> None:
        if not text:
            return
        self.pending += text
        while True:
            m = SENTENCE_END_RE.search(self.pending)
            nl = self.pending.find("\n")
            cut = m.end(1) if m else None
            if nl != -1 and (cut is None or nl < cut):
                cut = nl
            if cut is None:
                return
            piece = self.pending[:cut].strip()
            self.pending = self.pending[cut:].lstrip()
            if piece:
                self.out(piece)

    def flush(self) -> None:
        piece = self.pending.strip()
        self.pending = ""
        if piece:
            self.out(piece)


if __name__ == "__main__":  # quick self-test: python canvas/talker.py
    t = Talker(os.path.join(HERE, "data", "talker"))
    for content in [
        'heard: "hey, can you hear me?"\n[status] main agent: idle',
        'heard: "uh"\n[status] main agent: idle',
        '[chat] main agent just wrote: "Please reload once. Did it load?"\nheard: "hit that load"\n[status] main agent: idle',
        'heard: "so what I was thinking is that when we"\n[status] main agent: idle',
        '[continued]\nheard: "so what I was thinking is that when we add more layers the loss goes up, why is that"\n[status] main agent: idle',
        'heard: "and then the weather tonight will be mostly cloudy"\n[status] main agent: idle',
        'heard: "can you check whether my scale calculation on the board is right and mark it"\n[status] main agent: idle',
        "main_agent_reply:\nYes - $s = 5.005/254 \\approx 0.0197$. That's the bucket width. "
        "**How many of those buckets fit inside [-0.05, 0.05]?**\n[status] main agent: idle",
    ]:
        events = []
        r = t.turn(content, lambda k, d: events.append((k, d)))
        print(f"{r['mode']:>8} first={r['first_ms']}ms total={r['ms']}ms task={r['task']!r} text={r['text']!r} events={[k for k, _ in events]}")
    t.reset()
