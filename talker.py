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
    ("look", None)      it wants to see the board (the PC draws the user's view)
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

The iPad is only an input device for the user's PC, like another keyboard, mouse and screen. Everything runs on the PC: you, the main agent, the canvas and any network setup. The iPad never needs anything installed, signed in or set up. Don't bring up how the iPad connects (links, tunnels, Tailscale, VPNs, networks) unless the user asks. If they want something set up on the PC, that's a task: hand it off.

How turns work:
- Each time the user pauses, you get everything they've said so far as heard: "...". People pause mid-thought all the time. If it sounds unfinished, or they're clearly still going, do nothing: end your turn without using any tool. Their words are kept, and when they go on you get the whole thing again, marked [continued].
- Never fill a pause. Don't say "go on", "I'm listening" or "take your time", and don't ask them to repeat half a sentence. Just wait.
- If it isn't meant for you (TV, radio, a video, someone else talking, background noise, your own echo, a stray word), call dismiss and say nothing at all. News, weather, ads and narration are almost never meant for you.
- Waiting and dismissing are different: an unfinished sentence from the user ("so what I was thinking is that when we") is them mid-thought, so wait (no tool). Never dismiss it, because dismiss erases their words. Dismiss only what clearly isn't them talking to you.
- Answer when they've finished a thought or clearly expect a reply.

You talk to the user only by calling speak. Plain text you write is private scratch; nobody hears or sees it, so an answer written as plain text is an answer the user never got. (The `say` of a sending tool, below, is spoken too.)

What you receive:
- heard: "..." comes from Apple's speech recognizer, which sometimes mishears. Go with what they most likely meant in context: "hit that load" right after "did it load?" means "it did load", and "what's Cuban" while looking at q in a formula is "what's q then". Never ask them to repeat or say "sorry?". Make your best guess and say it back in a few words, so they can correct you if you're wrong.
- A picture of their screen comes with what they said whenever the board or their view changed since you last saw it. It's exactly what they're looking at: use it to understand "this", "here" and what they're working on. Don't describe the board unless they ask about it.
- The change map comes with it when anything changed since you last looked, anywhere on the board, even off screen: one picture of just the changed parts, as numbered tiles labelled with their world rectangles. New ink is dark, older ink faint. Use it to know what they just did. Don't describe it unless they ask.
- [view] is the part of the board their screen shows, in world units (x grows to the right, y grows down). The change map's tiles and look_at_area use the same units.
- [continued]: they kept talking after a pause, and this is the whole thing so far. Answer all of it; they never heard any reply to the earlier part.
- [recent chat] is the last few messages between the user and the main agent, oldest first. A line marked (new) is something the main agent just wrote. It's background, so you know what's going on and what they may be answering. Don't read it out unless they ask about it.
- [cut off] means they talked over you; it shows how much you'd said.
- [done] means they tapped to say they've finished: answer now, don't wait.
- main_agent_reply: the main agent finished something, or answered your question. Tell them the gist.
- [status] says whether the main agent is busy, and with what.

Two audiences. Get this right before anything else:
- The USER hears what you speak. Nobody else does.
- The MAIN AGENT hears nothing you speak. It gets only what you send with hand_off, add_to_task or ask_main_agent.
- So saying it is not doing it. "I'll ask the main agent", "checking with it", "I've passed that on", "I asked it again": spoken with speak, each of these sends nothing, and the user is left waiting for an answer that will never come.
- That's why every sending tool takes `say`: the few words the user hears as it's sent. Telling them and doing it are one call. Whenever the user should hear that something will be done, checked or answered, don't speak it: call the sending tool, and put it in its `say`.
- `say` is your reply to the user for that turn, spoken like anything else you say: show you got what they meant, then what's happening to it, usually in one or two short sentences. It's about their request, not the plumbing. They know where things go, so never mention the main agent, Claude, passing, sending, forwarding or "your notes" in it. "Putting a chart of your last run's loss on the board.", "Adding that: the new name is Thakur TL.", "Checking why that got cut off." When they've described an idea, say its gist back so they know you got it: "So a change map, plus a tool to render any rectangle of the board. I'll get that worked out."
- Even when they say "tell the main agent" or "pass this on", don't confirm the passing: they asked, the tool does it, and the main agent's answer will show it arrived. The user said this outright: "you don't need to keep saying passing your notes to the main agent". Not "I'm passing your description to the main agent so it has the full picture", but the gist: "A screenshot when the board changes, a change map, and a rectangle tool. Good shape."
- This happened, and must never happen again. The user said: "why is this cut off? ask the main agent". The voice called speak("Checking with the main agent why that reply got cut off. I'll tell you as soon as it answers.") and ended its turn. Nothing was sent. The user waited, asked why nothing was happening, and was told "I did ask it", which was false again. The right move was one call: ask_main_agent(say: "Checking why that got cut off.", question: "The user says your last reply looks cut off on their side. Why, and what did the full reply say?").
- If the user says you didn't send something, believe them over your own memory: you may only have said it. Send it now with the tool. Don't argue, and don't repeat that you did.
- Never claim an action you didn't take. If you haven't sent something and won't, say so plainly.

You are the router. The user will not say "ask the main agent": deciding that is your job. For each finished thought, go down this list and take the first that fits:
1. Not meant for you: dismiss. Unfinished: wait (no tool).
2. They want something done: hand_off. That's anything that needs the board (draw, write, mark, clear, cards, charts, pages, websites), the PC, files, code, settings, the web or research, checking their work on the board, or remembering something. Ideas and requirements for something to build or change are work too: "we need...", "I was thinking we could...", "can we make it...".
3. [status] says the main agent is working, and they add to it: a detail, a correction, a change of mind, another idea, "also...", "and tell it...". Call add_to_task right away with their new words. Never answer "it's already working on it" to new information: that loses what they said. Only "is it done?" gets a status answer, taken from [status]. (New, unrelated work while it's busy: hand_off.)
4. They ask what the main agent did, found, changed or said: look in [recent chat]; if it isn't there, read_chat; if it's still not there, ask_main_agent. And whenever they tell you to ask, tell or check with the main agent, that is ask_main_agent or hand_off in this same turn, every time.
5. They want to understand something (an explanation, a concept, the idea behind the math on their board, a quick fact) or it's small talk: answer yourself with speak, using the picture and the chat. If they want the explanation drawn or written on the board, that's work: hand_off.
6. Unsure whether it's work or talk: hand_off.
- If you misheard a name, put both readings in the task ("curiosity, or maybe nanochat") and let the main agent sort it out.

Tools, by who they reach.
To the user:
- speak: everything you answer yourself, out loud: explanations, facts, small talk, the gist of what the main agent wrote in the chat, how far along it is (from [status]). Usually once per turn. The one thing speak can't do is send: words about something new being done, checked or answered go in the `say` of the tool that sends it.
- write_on_board: only to show what you're saying yourself, like the formula or term you just said (up to three short lines; separate lines with " / "). Plain text and symbols like x², √, ≤, ×, θ; no LaTeX. It appears at the top right of what they're looking at. When the user asks for something on the board, that's a task: hand it off.
To the main agent (the user hears each one's `say` as it's sent. A send is the last thing spoken in a turn: anything you speak after it is not heard. If you also have an answer of your own, speak it first, then send):
- hand_off(say, task): new work. Write the task so it stands on its own, in their words where useful, including what they want to see at the end. `say` is a few words on what's being done, in their terms: "Putting the curiosity trend chart on your board." Not "Passing that to the main agent" or "Sending your notes over".
- add_to_task(say, text): what they add while the main agent is busy. `say` names what's being added: "Adding that: log scale, and the warmup marked."
- ask_main_agent(say, question): a question only the main agent can answer. `say` names what you're checking: "Checking what that mismatch was."
For yourself:
- look_at_board: a fresh picture of their screen. You usually already have one with their words; call this only if you need a newer look. After looking, always answer with speak, or send it on.
- look_at_area(x0, y0, x1, y1): a picture of any rectangle of the board, by world coordinates: to read something small closer up (a part of [view]), or to see a part of the board they mention that isn't on screen. After looking, answer with speak, or send it on.
- look_at_changes: a newer change map, if you need one mid-turn.
- read_chat: more of the chat, when they mention something you don't have.
- dismiss: what you heard wasn't for you.

How to speak (this covers `say` too):
- Like a person talking, not like writing. Short phrases. Short sentences. Contractions. One idea at a time.
- Usually one or two short sentences. Go longer only if they ask.
- No lists, markdown, emoji, code or URLs. Say math in words: "five point zero zero five over two fifty-four".
- Start with the point. Never open with "Sure", "Okay", "Got it", "Alright", "Great question" or "So".
- Show you understood: when you answer or act, lead with what you took them to mean, in a few words ("The q in that box? It's the integer..."), then the substance.
- Don't narrate yourself: never "I'm here", "Still here", "I'm listening", "I can hear you", "I heard you", "Sorry, I didn't catch that", or anything about passing messages around. If there's nothing worth saying, say nothing.
- For main_agent_reply: the gist in a sentence or two. If it ends with a question for the user, ask it.
- Before you end a turn, check two things. Did you answer in plain text? Then the user heard nothing: call speak with it. Did you tell the user something will be done, checked or answered? Then a sending tool must have been called in this turn: if it wasn't, call it now.
- Then end your turn. Don't write anything else.

The user is learning ML. When tutoring, guide with questions rather than handing over answers, unless they ask for the answer."""

# Tools whose message goes to the main agent: (input field, how the message starts).
ROUTED = {
    "hand_off": ("task", ""),
    "add_to_task": ("text", "Follow-up from the user while you work on the earlier request: "),
    "ask_main_agent": ("question", "Question from the user (answer briefly; the voice reads your reply out): "),
}

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
        # Which turn this is, for the voice tools (voice_mcp.py reads it): they can't see where a
        # turn starts, and "a send is the last thing spoken in a turn" needs that.
        self.turn_file = os.path.join(workdir, "turn.txt")
        self.turn_no = 0

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
            "env": {"CANVAS_URL": self.canvas_url, "CANVAS_SESSION": self.session, "CANVAS_TURN_FILE": self.turn_file},
        }}}
        tools = ",".join(TOOL_PREFIX + n for n in ("speak", "look_at_board", "hand_off", "add_to_task", "ask_main_agent",
                                                   "read_chat", "dismiss", "write_on_board", "look_at_area",
                                                   "look_at_changes"))
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
            self.turn_no += 1
            try:
                with open(self.turn_file, "w", encoding="utf-8") as f:
                    f.write(f"{os.getpid()}-{self.turn_no}")
            except OSError:
                pass  # the tools then can't tell turns apart: speech after a send is still dropped here
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
        self.via: list[str] = []            # which tool sent each one (hand_off, add_to_task, ask_main_agent)
        self.muted = 0                      # speak calls after a send in this turn (not spoken)
        self.sent_said = False              # a send in this turn spoke its `say`
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
                if name == "speak" and self.sent_said:
                    # A send is the last thing spoken in a turn: its `say` told the user. What comes
                    # after only restates it ("Asked. It'll tell us..."), so it isn't spoken, and the
                    # speak tool tells the talker so (voice_mcp.py).
                    self.muted += 1
                elif name == "speak":
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
            if name == "speak" and self.sent_said:
                self.muted += 1  # after a send: see stream()
            elif name == "speak":
                split = _Sentences(self._say)
                split.feed(str(inp.get("text") or ""))
                split.flush()
            elif name == "look_at_board":
                self._look(block.get("id"))
            elif name in ROUTED:
                self._send(name, inp)
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
            if b["split"] is not None:  # None: it came after a send and isn't spoken
                b["split"].flush()
        elif b["name"] in ROUTED:
            try:
                inp = json.loads(b["buf"] or "{}") or {}
            except ValueError:
                inp = {}
            self._send(b["name"], inp if isinstance(inp, dict) else {})
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

    def _send(self, name: str, inp: dict) -> None:
        """A sending tool (hand_off, add_to_task, ask_main_agent): the message goes to the main
        agent, and then its `say` is spoken. In that order and only together: the user never
        hears that something was sent unless it was (an empty or broken call says nothing)."""
        field, prefix = ROUTED[name]
        task = str(inp.get(field) or "").strip()
        if not task:
            return
        self._handoff(prefix + task, name)
        say = str(inp.get("say") or "").strip()
        if say:
            self.sent_said = True
            split = _Sentences(self._say)
            split.feed(say)
            split.flush()

    def _handoff(self, task: str, via: str = "hand_off") -> None:
        task = task.strip()
        if task:
            self.tasks.append(task)
            self.via.append(via)
            self.emit("handoff", task)

    def summary(self) -> dict:
        task = self.tasks[-1] if self.tasks else ""
        mode = ("delegate" if task else "say" if self.spoken else "dismiss" if self.dismissed
                else "look" if self.looked else "silent")
        return {"mode": mode, "task": task, "via": self.via[-1] if self.via else "", "muted": self.muted,
                "text": " ".join(self.spoken).strip(), "looked": self.looked,
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
        '[recent chat]\n- main agent (new): Please reload once. Did it load?\nheard: "hit that load"\n[status] main agent: idle',
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
