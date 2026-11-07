#!/usr/bin/env python3
"""Canvas server - iPad-first drawing + voice + chat bridge to a local Claude Code session.

    python canvas/server.py [--port 8765] [--quiet]

Binds 127.0.0.1 only. Python standard library only.
See README.md for the API contract.
"""
from __future__ import annotations

import argparse
import base64
import collections
import binascii
import hashlib
import hmac
import http.server
import json
import math
import os
import queue
import re
import secrets
import socket
import socketserver
import sys
import threading
import time
import traceback
import urllib.parse
from datetime import datetime
from email.utils import formatdate
from http.cookies import CookieError, SimpleCookie

try:  # voice talker (Claude Code headless on the user's subscription); optional
    import talker as talker_mod
except Exception:  # pragma: no cover
    talker_mod = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")
INBOX_DIR = os.path.join(DATA_DIR, "inbox")
TOKEN_FILE = os.path.join(DATA_DIR, "token.txt")
CONV_FILE = os.path.join(DATA_DIR, "conversation.json")
STROKES_FILE = os.path.join(DATA_DIR, "strokes.json")
LAYER_FILE = os.path.join(DATA_DIR, "claude_layer.json")
EVENTS_LOG = os.path.join(DATA_DIR, "events.log")
SERVER_INFO = os.path.join(DATA_DIR, "server.json")
STATIC_ROOT = os.path.normcase(os.path.realpath(STATIC_DIR))

# ---- asset versioning
# Safari keeps ES modules in its memory cache and does not always revalidate them on a
# reload, so a fresh app.js could run against a stale board.js (seen on the iPad:
# "board.setPaper is not a function" -> blank canvas). Every local script/style URL in the
# page, and every relative import inside the scripts, gets ?v=<build>. <build> changes
# whenever any top-level static file changes, so old and new files can never mix.
IMPORT_RE = re.compile(r"""((?:\bfrom|\bimport)\s*\(?\s*)(['"])(\.{1,2}/[^'"?#]+?\.m?js)\2""")
ASSET_ATTR_RE = re.compile(r"""(\b(?:src|href)=")((?![a-z]+:|//)[^"?#]+\.(?:m?js|css))(\?[^"]*)?(")""")
_build = {"t": 0.0, "v": ""}


def build_version() -> str:
    now = time.monotonic()
    if _build["v"] and now - _build["t"] < 1.0:
        return _build["v"]
    h = hashlib.sha1()
    for e in sorted(os.scandir(STATIC_DIR), key=lambda e: e.name):
        if e.is_file():
            st = e.stat()
            h.update(f"{e.name}:{st.st_mtime_ns}:{st.st_size};".encode())
    _build.update(t=now, v=h.hexdigest()[:10])
    return _build["v"]


def version_imports(body: bytes, ver: str) -> bytes:
    text = body.decode("utf-8")
    text = IMPORT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}?v={ver}{m.group(2)}", text)
    return text.encode("utf-8")


def version_page_assets(html: str, ver: str) -> str:
    def sub(m):
        q = m.group(3) or ""
        q = (q + "&" if q else "?") + "v=" + ver
        return f"{m.group(1)}{m.group(2)}{q}{m.group(4)}"
    return ASSET_ATTR_RE.sub(sub, html)

HOST = "127.0.0.1"
MAX_BODY = 25 * 1024 * 1024
MAX_TEXT = 100_000
MAX_SVG = 2 * 1024 * 1024
MAX_STATUS = 200
EVENT_TEXT_MAX = 500
KEEPALIVE_S = 15
COOKIE_NAME = "canvas_k"
MSG_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}$")
DRAW_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
LINEBREAKS_RE = re.compile(r"\s*[\r\n\x0b\x0c\x1c\x1d\x1e\x85  ]+\s*")
CONTROL_RE = re.compile(r"[\x00-\x08\x0e-\x1f\x7f]")

# Explicit MIME map: on Windows `mimetypes` reads the registry, which can map .js to
# text/plain and break ES module loading.
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
    "media-src 'self' blob:; manifest-src 'self'; worker-src 'none'; object-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

QUIET = False
_print_lock = threading.Lock()


def log(msg: str) -> None:
    if QUIET:
        return
    with _print_lock:
        try:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)
        except Exception:
            pass


def now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------- storage


def ensure_dirs() -> None:
    os.makedirs(INBOX_DIR, exist_ok=True)
    if not os.path.exists(EVENTS_LOG):
        open(EVENTS_LOG, "ab").close()


def load_or_create_token() -> str:
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            tok = f.read().strip()
        if len(tok) >= 16:
            return tok
    except FileNotFoundError:
        pass
    tok = secrets.token_urlsafe(24)
    with open(TOKEN_FILE, "w", encoding="utf-8", newline="\n") as f:
        f.write(tok + "\n")
    return tok


def read_json_list(path: str) -> list:
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except (ValueError, OSError) as e:
        log(f"warning: could not read {os.path.basename(path)} ({e}); starting empty")
        return []


def write_bytes_atomic(path: str, data: bytes) -> None:
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    for _ in range(40):  # Windows: target may be briefly locked by a reader
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05)
    with open(path, "wb") as f:  # last resort
        f.write(data)
    try:
        os.remove(tmp)
    except OSError:
        pass


def write_json_atomic(path: str, obj, pretty: bool = False) -> None:
    if pretty:
        text = json.dumps(obj, ensure_ascii=False, indent=1)
    else:
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    write_bytes_atomic(path, (text + "\n").encode("utf-8"))


class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.conversation = read_json_list(CONV_FILE)
        self.strokes = read_json_list(STROKES_FILE)
        self.layer = read_json_list(LAYER_FILE)
        self.status = {"status": "idle", "ts": now_ms()}

    def save_conversation(self) -> None:
        write_json_atomic(CONV_FILE, self.conversation, pretty=True)

    def save_strokes(self) -> None:
        write_json_atomic(STROKES_FILE, self.strokes)

    def save_layer(self) -> None:
        write_json_atomic(LAYER_FILE, self.layer, pretty=True)


# --------------------------------------------------------------------------- SSE hub


def sse_frame(event: str, data) -> bytes:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n".encode("utf-8")


class SSEClient:
    __slots__ = ("q", "alive", "addr")

    def __init__(self, addr) -> None:
        self.q: queue.Queue = queue.Queue(maxsize=1000)
        self.alive = True
        self.addr = addr


class Hub:
    """Fan-out to SSE clients plus a sequenced event log for long-polling.

    Long-polling exists because Cloudflare quick tunnels buffer SSE streams, so
    the page cannot rely on EventSource when reached through the tunnel.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.clients: set[SSEClient] = set()
        self.cond = threading.Condition()
        self.seq = 0
        self.log: collections.deque = collections.deque(maxlen=500)
        self.epoch = secrets.token_hex(4)  # changes on every server start

    def poll(self, since: int, epoch: str, wait: float) -> dict:
        deadline = time.monotonic() + wait
        with self.cond:
            stale = (
                epoch != self.epoch
                or since > self.seq
                or (self.log and since < self.log[0][0] - 1)
            )
            if stale:
                return {"epoch": self.epoch, "next": self.seq, "reset": True, "events": []}
            while self.seq <= since:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.cond.wait(remaining)
            events = [{"seq": s, "event": e, "data": d} for (s, e, d) in self.log if s > since]
            return {"epoch": self.epoch, "next": self.seq, "reset": False, "events": events}

    def register(self, addr) -> SSEClient:
        c = SSEClient(addr)
        with self.lock:
            self.clients.add(c)
        return c

    def unregister(self, c: SSEClient) -> None:
        with self.lock:
            self.clients.discard(c)
        c.alive = False

    def count(self) -> int:
        with self.lock:
            return len(self.clients)

    def broadcast(self, event: str, data) -> None:
        frame = sse_frame(event, data)
        with self.cond:
            self.seq += 1
            self.log.append((self.seq, event, data))
            self.cond.notify_all()
        with self.lock:
            for c in list(self.clients):
                try:
                    c.q.put_nowait(frame)
                except queue.Full:  # client is not reading; drop it
                    self.clients.discard(c)
                    c.alive = False

    def close_all(self) -> None:
        with self.lock:
            for c in list(self.clients):
                c.alive = False
                try:
                    c.q.put_nowait(None)
                except queue.Full:
                    pass


# --------------------------------------------------------------------------- helpers


class HttpError(Exception):
    def __init__(self, code: int, msg: str) -> None:
        super().__init__(msg)
        self.code = code
        self.msg = msg


def num(v, default=None):
    if isinstance(v, bool):
        return default
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def clean_line(s, limit: int | None = None) -> str:
    if not isinstance(s, str):
        return ""
    s = LINEBREAKS_RE.sub(" / ", s.strip())
    s = CONTROL_RE.sub(" ", s).replace("\t", " ")
    if limit is not None and len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    return s


def fmt_ts(seconds: float) -> str:
    tenths = int(round(max(0.0, seconds) * 10))
    m, rem = divmod(tenths, 600)
    return f"{m:02d}:{rem // 10:02d}.{rem % 10}"


def new_msg_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)


def build_timeline_text(tl: dict, mode: str, text: str) -> str:
    w = int(num(tl.get("width"), 0) or 0)
    h = int(num(tl.get("height"), 0) or 0)
    lines = [f"Snapshot {w}x{h} px ({mode} mode). New ink is full strength, older ink faded."]
    rows = []
    events = tl.get("events") if isinstance(tl.get("events"), list) else []
    for i, ev in enumerate(events[:2000]):
        if not isinstance(ev, dict):
            continue
        start = num(ev.get("start"), 0.0) or 0.0
        end = max(start, num(ev.get("end"), start) or start)
        stamp = f"[{fmt_ts(start)}–{fmt_ts(end)}]"
        kind = ev.get("type")
        if kind == "speech":
            t = clean_line(ev.get("text"), 2000)
            if t:
                rows.append((start, 0, i, f'{stamp} speech: "{t}"'))
        elif kind == "ink":
            color = clean_line(ev.get("color"), 40) or "black"
            if ev.get("tool") in ("highlighter", "hl"):
                color += " highlighter"
            bbox = ev.get("bbox")
            vals = [num(v) for v in bbox] if isinstance(bbox, list) and len(bbox) == 4 else None
            if vals and all(v is not None for v in vals) and ev.get("visible", True) is not False:
                x0, y0, x1, y1 = (int(round(v)) for v in vals)
                rows.append((start, 1, i, f"{stamp} ink ({color}) at x={x0}..{x1}, y={y0}..{y1}"))
            else:
                rows.append((start, 1, i, f"{stamp} ink ({color}) outside the snapshot"))
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    lines.extend(r[3] for r in rows)
    if not rows:
        lines.append("(no speech segments or new ink recorded for this message)")
    lines.append("")
    if num(tl.get("new_strokes"), None) == 0:
        lines.append("No new ink since the previous message (all ink is shown faded).")
    if tl.get("claude_items"):
        lines.append("Claude-layer drawings are included at reduced opacity.")
    world = tl.get("world") if isinstance(tl.get("world"), dict) else None
    if world:
        wx, wy, sc = num(world.get("x")), num(world.get("y")), num(world.get("scale"))
        if wx is not None and wy is not None and sc:
            lines.append(
                f"World mapping (for draw.py): world_x = {wx:.1f} + px_x / {sc:.4f}, "
                f"world_y = {wy:.1f} + px_y / {sc:.4f}"
            )
    view = tl.get("view") if isinstance(tl.get("view"), dict) else None
    if view:
        vals = [num(view.get(k)) for k in ("x0", "y0", "x1", "y1")]
        if all(v is not None for v in vals):
            lines.append(
                f"User's current view in world units: x={vals[0]:.0f}..{vals[2]:.0f}, "
                f"y={vals[1]:.0f}..{vals[3]:.0f}"
            )
    if text.strip():
        lines.append("")
        lines.append("Message text (as sent):")
        lines.append(text.strip())
    return "\n".join(lines).rstrip() + "\n"


# --------------------------------------------------------------------------- HTTP


class VoiceState:
    """What the talker should know about the main agent: idle, or working on a handed-off task."""

    def __init__(self):
        self.lock = threading.Lock()
        self.task: str | None = None
        self.since = 0.0
        self.seen_reply = ""        # id of the latest main-agent chat message the talker was shown
        self.look_event = threading.Event()
        self.look_image: dict | None = None
        self.running = ""           # turn id the talker is working on
        self.cancelled: collections.deque = collections.deque(maxlen=64)
        self.fragment_seen = False  # the talker saw words it didn't answer yet (for [continued])

    # cancelling: the user kept talking, so a turn about the first part is stale
    def cancel(self, turn: str) -> bool:
        with self.lock:
            self.cancelled.append(turn)
            return self.running == turn

    def is_cancelled(self, turn: str) -> bool:
        with self.lock:
            return turn in self.cancelled

    # look_at_board: the talker asks, the page uploads a snapshot, the voice MCP tool collects it
    def look_requested(self) -> None:
        with self.lock:
            self.look_image = None
            self.look_event = threading.Event()

    def look_arrived(self, media_type: str, data: str) -> None:
        with self.lock:
            self.look_image = {"media_type": media_type, "data": data}
            self.look_event.set()

    def look_wait(self, timeout: float) -> dict | None:
        with self.lock:
            ev = self.look_event
        ev.wait(timeout)
        with self.lock:
            return self.look_image

    def delegate(self, task: str) -> None:
        with self.lock:
            self.task, self.since = task, time.time()

    def clear(self) -> None:
        with self.lock:
            self.task = None

    def status_line(self) -> str:
        with self.lock:
            if not self.task:
                return "[status] main agent: idle"
            secs = int(time.time() - self.since)
            return f'[status] main agent: working on "{self.task[:240]}" ({secs} s so far)'


VOICE = VoiceState()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Canvas/1.0"
    sys_version = ""
    timeout = 75

    store: Store = None  # type: ignore[assignment]
    hub: Hub = None  # type: ignore[assignment]
    talker = None  # talker_mod.Talker | None
    token: str = ""
    events_lock = threading.Lock()

    # quiet default logging; we log meaningful events ourselves
    def log_message(self, format, *args):  # noqa: A002
        return

    # ---- dispatch
    def do_GET(self):
        self._dispatch()

    def do_HEAD(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def do_OPTIONS(self):
        self._dispatch()

    def _dispatch(self):
        try:
            parts = urllib.parse.urlsplit(self.path)
            self.query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
            path = urllib.parse.unquote(parts.path) or "/"
            if not self._authorized():
                self._unauthorized(path)
                return
            self._route(self.command, path)
        except HttpError as e:
            if e.code >= 500:
                log(f"error {e.code}: {e.msg}")
            self._send_json(e.code, {"error": e.msg})
        except (ConnectionError, TimeoutError, socket.timeout):
            self.close_connection = True
        except Exception:
            log("internal error:\n" + traceback.format_exc())
            try:
                self._send_json(500, {"error": "internal server error"})
            except Exception:
                self.close_connection = True

    def _route(self, method: str, path: str):
        if path in ("/", "/index.html"):
            if method not in ("GET", "HEAD"):
                raise HttpError(405, "method not allowed")
            return self._serve_index()
        if path.startswith("/api/"):
            return self._route_api(method, path)
        if path.startswith("/app/"):
            if method not in ("GET", "HEAD"):
                raise HttpError(405, "method not allowed")
            return self._serve_app(path)
        if method not in ("GET", "HEAD"):
            raise HttpError(405, "method not allowed")
        return self._serve_static(path)

    def _route_api(self, method: str, path: str):
        routes = {
            ("GET", "/api/state"): self._api_state,
            ("GET", "/api/events"): self._api_events,
            ("GET", "/api/poll"): self._api_poll,
            ("POST", "/api/mirror"): self._api_mirror,
            ("POST", "/api/talk"): self._api_talk,
            ("POST", "/api/talk/reset"): self._api_talk_reset,
            ("POST", "/api/talk/cancel"): self._api_talk_cancel,
            ("POST", "/api/talk/board"): self._api_talk_board_put,
            ("GET", "/api/talk/board"): self._api_talk_board_get,
            ("POST", "/api/clientlog"): self._api_clientlog,
            ("GET", "/api/ping"): self._api_ping,
            ("POST", "/api/message"): self._api_message,
            ("POST", "/api/reply"): self._api_reply,
            ("POST", "/api/status"): self._api_status,
            ("POST", "/api/draw"): self._api_draw,
            ("POST", "/api/draw/clear"): self._api_draw_clear,
            ("POST", "/api/draw/remove"): self._api_draw_remove,
            ("PUT", "/api/strokes"): self._api_strokes,
            ("POST", "/api/strokes"): self._api_strokes,
        }
        fn = routes.get(("GET" if method == "HEAD" else method, path))
        if fn:
            return fn()
        m = re.match(r"^/api/inbox/([^/]+)/snapshot\.png$", path)
        if m and method in ("GET", "HEAD"):
            return self._api_snapshot(m.group(1))
        m = re.match(r"^/api/draw/([^/]+)$", path)
        if m and method == "DELETE":
            return self._remove_draw(m.group(1))
        if any(p == path for (_, p) in routes):
            raise HttpError(405, "method not allowed")
        raise HttpError(404, "not found")

    # ---- auth
    def _authorized(self) -> bool:
        want = self.token.encode("utf-8")
        candidates = []
        k = self.query.get("k")
        if k:
            candidates.append(k[0])
        hdr = self.headers.get("X-Canvas-Key")
        if hdr:
            candidates.append(hdr.strip())
        raw_cookie = self.headers.get("Cookie")
        if raw_cookie:
            try:
                c = SimpleCookie()
                c.load(raw_cookie)
                if COOKIE_NAME in c:
                    candidates.append(c[COOKIE_NAME].value)
            except CookieError:
                pass
        ok = False
        for cand in candidates:
            if hmac.compare_digest(cand.encode("utf-8"), want):
                ok = True
        return ok

    def _unauthorized(self, path: str):
        self._discard_body()
        if path.startswith("/api/"):
            self._send_json(401, {"error": "unauthorized: missing or invalid key"})
            return
        body = (
            "<!DOCTYPE html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
            "<title>Canvas</title><body style=\"font:16px -apple-system,system-ui,sans-serif;"
            "display:grid;place-items:center;height:100vh;margin:0;background:#f7f5f0;color:#1d1d1f\">"
            "<div style='text-align:center'><h2 style='letter-spacing:-.02em'>Canvas is locked</h2>"
            "<p style='color:#6e6e73'>Open the link that includes <code>?k=&lt;key&gt;</code>.</p></div>"
        ).encode("utf-8")
        self._send(401, body, MIME[".html"])

    # ---- low-level responses
    def _security_headers(self, html: bool = False):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if html:
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Frame-Options", "DENY")

    def _send(self, code: int, body: bytes, ctype: str, headers: dict | None = None,
              cache: str = "no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self._security_headers(html=ctype.startswith("text/html"))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _send_json(self, code: int, obj):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send(code, body, MIME[".json"])

    def _discard_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if 0 < n <= MAX_BODY:
            try:
                self.rfile.read(n)
            except Exception:
                self.close_connection = True
        elif n > MAX_BODY:
            self.close_connection = True

    def _read_json(self) -> dict:
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self.close_connection = True
            raise HttpError(411, "chunked bodies not supported; send Content-Length")
        cl = self.headers.get("Content-Length")
        if cl is None:
            raise HttpError(411, "Content-Length required")
        try:
            n = int(cl)
        except ValueError:
            raise HttpError(400, "bad Content-Length")
        if n < 0:
            raise HttpError(400, "bad Content-Length")
        if n > MAX_BODY:
            self.close_connection = True
            raise HttpError(413, f"body too large (max {MAX_BODY} bytes)")
        chunks, remaining = [], n
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                raise ConnectionError("client closed during body")
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError):
            raise HttpError(400, "body must be UTF-8 JSON")
        if not isinstance(data, dict):
            raise HttpError(400, "JSON body must be an object")
        return data

    # ---- page + static
    def _serve_index(self):
        path = os.path.join(STATIC_DIR, "index.html")
        try:
            with open(path, "r", encoding="utf-8") as f:
                html = f.read()
        except FileNotFoundError:
            raise HttpError(500, "static/index.html missing")
        html = html.replace("%%K%%", urllib.parse.quote(self.token, safe=""))
        html = version_page_assets(html, build_version())
        secure = (self.headers.get("X-Forwarded-Proto") or "").lower() == "https"
        cookie = (
            f"{COOKIE_NAME}={self.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax"
            + ("; Secure" if secure else "")
        )
        self._send(200, html.encode("utf-8"), MIME[".html"], {"Set-Cookie": cookie})

    def _serve_static(self, path: str):
        rel = path.lstrip("/")
        if not rel or "\\" in rel or "\x00" in rel or ":" in rel:
            raise HttpError(404, "not found")
        parts = rel.split("/")
        if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
            raise HttpError(404, "not found")
        full = os.path.realpath(os.path.join(STATIC_DIR, *parts))
        norm = os.path.normcase(full)
        if os.path.commonpath([norm, STATIC_ROOT]) != STATIC_ROOT or not os.path.isfile(full):
            raise HttpError(404, "not found")
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        st = os.stat(full)
        body = None
        if ext in (".js", ".mjs"):
            # Imports carry the build version, so the ETag must follow the rewritten body.
            with open(full, "rb") as f:
                body = version_imports(f.read(), build_version())
            etag = '"' + hashlib.sha1(body).hexdigest()[:20] + '"'
            headers = {"ETag": etag}
        else:
            etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
            headers = {"ETag": etag, "Last-Modified": formatdate(st.st_mtime, usegmt=True)}
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if body is None:
            with open(full, "rb") as f:
                body = f.read()
        self._send(200, body, ctype, headers, cache="no-cache")

    # ---- the iPad app (canvas/ios), built by GitHub Actions and installed with SideStore
    def _serve_app(self, path: str):
        """/app/Canvas.ipa: the build. /app/source.json: a SideStore/AltStore source, so the
        app shows updates. Both need the key (?k=), since SideStore sends no cookies."""
        app_dir = os.path.join(DATA_DIR, "app")
        ipa = os.path.join(app_dir, "Canvas.ipa")
        if path == "/app/Canvas.ipa":
            if not os.path.isfile(ipa):
                raise HttpError(404, "the app hasn't been built yet")
            with open(ipa, "rb") as f:
                body = f.read()
            return self._send(200, body, "application/octet-stream",
                              {"Content-Disposition": 'attachment; filename="Canvas.ipa"'})
        if path == "/app/source.json":
            if not os.path.isfile(ipa):
                raise HttpError(404, "the app hasn't been built yet")
            try:
                with open(os.path.join(app_dir, "build.json"), "r", encoding="utf-8") as f:
                    info = json.load(f)
            except (OSError, ValueError):
                info = {}
            proto = "https" if (self.headers.get("X-Forwarded-Proto") or "").lower() == "https" else "http"
            origin = f"{proto}://{self.headers.get('Host') or f'{HOST}:{self.server.server_address[1]}'}"
            k = urllib.parse.quote(self.token, safe="")
            st = os.stat(ipa)
            source = {
                "name": "Canvas",
                "identifier": "com.canvasboard.source",
                "apps": [{
                    "name": "Canvas",
                    "bundleIdentifier": "com.canvasboard.canvas",
                    "developerName": "Claude",
                    "subtitle": "Pencil canvas + voice for Claude Code",
                    "localizedDescription": "Your canvas as an iPad app: Apple Pencil, Apple's own speech "
                                            "recognition, and every installed voice, including Premium ones.",
                    "iconURL": f"{origin}/icon-512.png?k={k}",
                    "tintColor": "D2693F",
                    "versions": [{
                        "version": str(info.get("version") or "1.1"),
                        "buildVersion": str(info.get("build") or int(st.st_mtime)),
                        "date": datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(timespec="seconds"),
                        "localizedDescription": str(info.get("notes") or "Latest build."),
                        "downloadURL": f"{origin}/app/Canvas.ipa?k={k}",
                        "size": st.st_size,
                        "minOSVersion": "17.0",
                    }],
                    "appPermissions": {"entitlements": [], "privacy": {
                        "NSMicrophoneUsageDescription": "Canvas listens while you talk, so Claude can hear what you say.",
                        "NSSpeechRecognitionUsageDescription": "Canvas turns what you say into text for Claude.",
                    }},
                }],
                "news": [],
            }
            return self._send_json(200, source)
        raise HttpError(404, "not found")

    # ---- API: reads
    def _api_ping(self):
        self._send_json(200, {"ok": True, "time": now_ms(), "clients": self.hub.count()})

    def _api_state(self):
        st = self.store
        with st.lock:
            payload = {
                "conversation": st.conversation,
                "strokes": st.strokes,
                "claude_layer": st.layer,
                "status": st.status,
                "server_time": now_ms(),
            }
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send(200, body, MIME[".json"])

    def _api_snapshot(self, mid: str):
        if not MSG_ID_RE.match(mid):
            raise HttpError(404, "not found")
        p = os.path.join(INBOX_DIR, mid, "snapshot.png")
        if not os.path.isfile(p):
            raise HttpError(404, "not found")
        with open(p, "rb") as f:
            body = f.read()
        self._send(200, body, MIME[".png"], cache="private, max-age=31536000, immutable")

    def _api_events(self):
        client = self.hub.register(self.client_address)
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Transfer-Encoding", "chunked")
            self._security_headers()
            self.end_headers()
            with self.store.lock:
                hello = {"server_time": now_ms(), "status": self.store.status}
            self._chunk(b"retry: 3000\n\n" + sse_frame("hello", hello))
            while client.alive:
                try:
                    frame = client.q.get(timeout=KEEPALIVE_S)
                except queue.Empty:
                    frame = b": keepalive\n\n"
                if frame is None:
                    break
                self._chunk(frame)
            try:
                self.wfile.write(b"0\r\n\r\n")
            except Exception:
                pass
        except (ConnectionError, TimeoutError, socket.timeout, OSError):
            pass
        finally:
            self.hub.unregister(client)

    def _chunk(self, data: bytes):
        self.wfile.write(b"%X\r\n%s\r\n" % (len(data), data))
        self.wfile.flush()

    # ---- API: page -> Claude
    def _api_message(self):
        body = self._read_json()
        text = body.get("text") or ""
        if not isinstance(text, str):
            raise HttpError(400, "text must be a string")
        text = text[:MAX_TEXT]
        png = None
        image = body.get("image")
        if image:
            if not isinstance(image, str) or not image.startswith("data:image/png;base64,"):
                raise HttpError(400, "image must be a PNG data URL")
            try:
                png = base64.b64decode(image.split(",", 1)[1], validate=True)
            except (binascii.Error, ValueError):
                raise HttpError(400, "image is not valid base64")
            if not png.startswith(b"\x89PNG\r\n\x1a\n"):
                raise HttpError(400, "image is not a PNG")
        timeline = body.get("timeline") if isinstance(body.get("timeline"), dict) else {}
        mode = body.get("board_image_mode") or timeline.get("mode") or "view"
        mode = "board" if str(mode).lower() in ("board", "whole", "whole_board", "fit") else "view"
        cid = body.get("cid") if isinstance(body.get("cid"), str) else None
        client_ts = num(body.get("client_ts"))

        st = self.store
        with st.lock:
            mid = new_msg_id()
            while os.path.exists(os.path.join(INBOX_DIR, mid)):
                mid = new_msg_id()
            d = os.path.join(INBOX_DIR, mid)
            os.makedirs(d)
            img_path = os.path.abspath(os.path.join(d, "snapshot.png"))
            tl_path = os.path.abspath(os.path.join(d, "timeline.txt"))
            if png:
                write_bytes_atomic(img_path, png)
            write_bytes_atomic(tl_path, build_timeline_text(timeline, mode, text).encode("utf-8"))
            ts = now_ms()
            record = {
                "id": mid,
                "received_at": datetime.now().isoformat(timespec="seconds"),
                "text": text,
                "board_image_mode": mode,
                "snapshot": "snapshot.png" if png else None,
                "snapshot_path": img_path if png else None,
                "timeline_path": tl_path,
                "timeline": timeline,
                "client_ts": client_ts,
                "cid": cid,
            }
            write_json_atomic(os.path.join(d, "message.json"), record, pretty=True)
            entry = {
                "id": mid,
                "role": "user",
                "text": text,
                "ts": ts,
                "client_ts": client_ts,
                "cid": cid,
                "image": f"/api/inbox/{mid}/snapshot.png" if png else None,
                "mode": mode,
                "width": int(num(timeline.get("width"), 0) or 0),
                "height": int(num(timeline.get("height"), 0) or 0),
            }
            st.conversation.append(entry)
            st.save_conversation()
            st.status = {"status": "sent", "ts": ts}
            line = (
                f"MSG {mid} | {clean_line(text, EVENT_TEXT_MAX)} | "
                f"img={img_path if png else 'none'} | timeline={tl_path}\n"
            )
            with self.events_lock:
                with open(EVENTS_LOG, "ab") as f:
                    f.write(line.encode("utf-8"))
                    f.flush()
                    os.fsync(f.fileno())
            status = dict(st.status)
        log(f"message {mid} ({len(text)} chars, {len(png) if png else 0} B png, {mode})")
        self.hub.broadcast("message", entry)
        self.hub.broadcast("status", status)
        self._send_json(200, {"id": mid})

    def _api_strokes(self):
        body = self._read_json()
        strokes = body.get("strokes")
        if not isinstance(strokes, list):
            raise HttpError(400, "strokes must be a list")
        client = body.get("client") if isinstance(body.get("client"), str) else None
        st = self.store
        with st.lock:
            st.strokes = strokes
            st.save_strokes()
        self.hub.broadcast("strokes", {"client": client, "count": len(strokes), "ts": now_ms()})
        self._send_json(200, {"ok": True, "count": len(strokes)})

    # ---- API: Claude -> page
    def _set_status(self, status: str):
        st = self.store
        with st.lock:
            st.status = {"status": status, "ts": now_ms()}
            snap = dict(st.status)
        self.hub.broadcast("status", snap)
        return snap

    def _api_reply(self):
        body = self._read_json()
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise HttpError(400, "text (markdown string) is required")
        text = text[:MAX_TEXT]
        status = body.get("status")
        status = status.strip()[:MAX_STATUS] if isinstance(status, str) and status.strip() else "idle"
        ts = now_ms()
        entry = {
            "id": "c-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2),
            "role": "claude",
            "text": text,
            "ts": ts,
        }
        st = self.store
        with st.lock:
            st.conversation.append(entry)
            st.save_conversation()
        log(f"reply {entry['id']} ({len(text)} chars)")
        VOICE.clear()
        self.hub.broadcast("reply", entry)
        self._set_status(status)
        self._send_json(200, {"id": entry["id"]})

    def _api_poll(self):
        def qnum(name, default):
            try:
                return float(self.query.get(name, [default])[0])
            except (TypeError, ValueError):
                return float(default)

        since = int(qnum("since", -1))
        wait = min(max(qnum("wait", 25), 0.0), 25.0)
        epoch = self.query.get("epoch", [""])[0]
        res = self.hub.poll(since, epoch, wait)
        with self.store.lock:
            res["status"] = self.store.status
        self._send_json(200, res)

    def _api_mirror(self):
        """Mirror a main-chat turn (typed in Claude Code / Remote Control) into the canvas.

        Never touches events.log: mirrored user turns already reached Claude.
        """
        body = self._read_json()
        role = body.get("role")
        if role not in ("user", "claude"):
            raise HttpError(400, "role must be 'user' or 'claude'")
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise HttpError(400, "text is required")
        entry = {
            "id": ("u-" if role == "user" else "c-") + datetime.now().strftime("%Y%m%d-%H%M%S")
            + "-" + secrets.token_hex(2),
            "role": role,
            "text": text[:MAX_TEXT],
            "ts": now_ms(),
            "source": "chat",
        }
        st = self.store
        with st.lock:
            st.conversation.append(entry)
            st.save_conversation()
        log(f"mirror {role} {entry['id']} ({len(entry['text'])} chars)")
        self.hub.broadcast("message" if role == "user" else "reply", entry)
        if role == "claude":
            VOICE.clear()
            self._set_status("idle")
        elif body.get("thinking", True):
            self._set_status("thinking")
        self._send_json(200, {"id": entry["id"]})

    # ---- voice talker
    def _api_talk(self):
        """One voice turn through the fast talker (talker.py; its tools are in voice_mcp.py).

        Body: {kind: "utterance"|"main_reply"|"warmup", turn?, text?, continued?, interrupted?, log?}
        The page names the turn (turn: "t-..."), so it can cancel it (POST /api/talk/cancel) before
        it even starts. A turn produces numbered events, each broadcast as "talk" {turn, n, ...}:
            {say: sentence} | {look: true} | {handoff: task} | {dismiss: true}
            | {done: true, mode, task, text, ms, first_ms, error?}
        The POST answers as soon as the first event exists, with {turn, events: [...so far]},
        so the first words don't wait for a long-poll round trip. The page de-duplicates by n.
        """
        talker = self.talker
        if talker is None:
            raise HttpError(503, "voice talker unavailable")
        body = self._read_json()
        kind = body.get("kind") or "utterance"
        if kind == "warmup":
            def warm():
                try:
                    talker.turn("[keep-alive: voice mode is on and nothing was said. Don't speak or use any tool.]")
                except Exception as exc:
                    log(f"talker warmup failed: {exc}")
            threading.Thread(target=warm, daemon=True).start()
            return self._send_json(200, {"ok": True})

        heard = ""
        parts = []
        if kind == "utterance":
            heard = body.get("text")
            if not isinstance(heard, str) or not heard.strip():
                raise HttpError(400, "text is required")
            heard = heard.strip()[:2000]
            chat = self._unseen_main_message()
            if chat:
                parts.append(f'[chat] the main agent\'s latest message: "{chat}"')
            if body.get("continued") and VOICE.fragment_seen:
                parts.append("[continued] the user kept talking; this is the whole thing so far")
            parts.append(f'heard: "{heard}"')
            if body.get("done"):
                parts.append("[done] they tapped the orb: they've finished, so answer now")
            cut = body.get("interrupted")
            if isinstance(cut, str) and cut.strip():
                parts.append(f'[cut off] they talked over you after: "{cut.strip()[:400]}"')
        elif kind == "main_reply":
            text = body.get("text")
            if not isinstance(text, str) or not text.strip():
                raise HttpError(400, "text is required")
            self._unseen_main_message()  # marks it seen
            parts.append(f"main_agent_reply:\n{text.strip()[:8000]}")
        else:
            raise HttpError(400, "unknown kind")
        parts.append(VOICE.status_line())
        content = "\n".join(parts)

        turn_id = body.get("turn") if isinstance(body.get("turn"), str) else ""
        if not re.match(r"^t-[A-Za-z0-9]{4,24}$", turn_id):
            turn_id = "t-" + secrets.token_hex(4)
        ready = threading.Event()
        lock = threading.Lock()
        events: list = []
        hub = self.hub

        def push(ev: dict) -> None:
            with lock:
                ev = {"turn": turn_id, "n": len(events) + 1, **ev}
                events.append(ev)
            hub.broadcast("talk", ev)
            ready.set()

        def on_event(k, data):
            if k == "say":
                push({"say": data})
            elif k == "look":
                VOICE.look_requested()
                push({"look": True})
            elif k == "handoff":
                VOICE.delegate(data)
                push({"handoff": data})
            elif k == "dismiss":
                push({"dismiss": True})

        def still_wanted() -> bool:
            if VOICE.is_cancelled(turn_id):
                return False
            with VOICE.lock:
                VOICE.running = turn_id
            return True

        def work():
            res, err = None, None
            try:
                res = talker.turn(content, on_event, still_wanted=still_wanted)
            except Exception as exc:
                err = str(exc)
                log(f"talker error: {exc}")
            finally:
                with VOICE.lock:
                    if VOICE.running == turn_id:
                        VOICE.running = ""
            if res is None:
                push({"done": True, "error": err or "talker failed"})
                return
            if kind == "utterance" and res["mode"] != "cancelled":
                # it saw these words; unless it answered or dismissed them, they're still pending
                VOICE.fragment_seen = res["mode"] in ("silent", "look")
            push({"done": True, **{k: v for k, v in res.items() if k != "notes"}})
            log(f"talk {turn_id} {kind} -> {res['mode']} first={res['first_ms']}ms total={res['ms']}ms")
            self._log_voice(kind, heard, res, test=not body.get("log", True))

        threading.Thread(target=work, daemon=True).start()
        ready.wait(timeout=60)
        with lock:
            so_far = list(events)
        if not so_far:
            raise HttpError(504, "talker did not answer")
        self._send_json(200, {"turn": turn_id, "events": so_far})

    def _unseen_main_message(self) -> str:
        """The main agent's latest chat message, if the talker hasn't been shown it yet."""
        st = self.store
        with st.lock:
            latest = next((e for e in reversed(st.conversation)
                           if e.get("role") == "claude" and e.get("source") != "talker"), None)
        if not latest:
            return ""
        with VOICE.lock:
            if VOICE.seen_reply == latest.get("id"):
                return ""
            VOICE.seen_reply = latest.get("id") or ""
        text = re.sub(r"\s+", " ", str(latest.get("text") or "")).strip()
        return "…" + text[-700:] if len(text) > 700 else text

    def _log_voice(self, kind: str, heard: str, res: dict, test: bool = False) -> None:
        """Voice turns go to data/voice.log, not the chat: the chat panel is the main agent's."""
        rec = {"ts": datetime.now().isoformat(timespec="seconds"), "kind": kind, "heard": heard, "test": test,
               **{k: res.get(k) for k in ("mode", "task", "text", "looked", "notes", "first_ms", "ms")}}
        with open(os.path.join(DATA_DIR, "voice.log"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def _api_talk_board_put(self):
        """The page's snapshot for the talker's look_at_board."""
        body = self._read_json()
        m = re.match(r"^data:(image/(?:png|jpeg));base64,(.+)$", body.get("image") or "", re.S)
        if not m:
            raise HttpError(400, "image must be a PNG or JPEG data URL")
        VOICE.look_arrived(m.group(1), m.group(2))
        self._send_json(200, {"ok": True})

    def _api_talk_board_get(self):
        """voice_mcp.py waits here for that snapshot."""
        try:
            wait = min(15.0, max(0.0, float(self.query.get("wait", ["9"])[0])))
        except ValueError:
            wait = 9.0
        img = VOICE.look_wait(wait)
        if not img:
            raise HttpError(504, "no board snapshot arrived")
        self._send_json(200, img)

    def _api_clientlog(self):
        """Page errors reported by static/guard.js; appended to data/client.log."""
        body = self._read_json()
        rec = {k: body.get(k) for k in ("kind", "msg", "src", "line", "col", "stack", "ua")}
        rec["ts"] = datetime.now().isoformat(timespec="seconds")
        line = json.dumps(rec, ensure_ascii=False)[:6000]
        with open(os.path.join(DATA_DIR, "client.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
        log(f"client {rec.get('kind')}: {str(rec.get('msg'))[:200]} @ {rec.get('src')}:{rec.get('line')}")
        self._send_json(200, {"ok": True})

    def _api_talk_cancel(self):
        """The user kept talking: drop this turn (skip it if queued, interrupt it if running)."""
        body = self._read_json()
        turn = body.get("turn")
        if not isinstance(turn, str) or not turn:
            raise HttpError(400, "turn is required")
        if VOICE.cancel(turn) and self.talker is not None:
            self.talker.interrupt()
        self._send_json(200, {"ok": True})

    def _api_talk_reset(self):
        if self.talker is not None:
            self.talker.reset()
        VOICE.clear()
        self._send_json(200, {"ok": True})

    def _api_status(self):
        body = self._read_json()
        status = body.get("status")
        if not isinstance(status, str) or not status.strip():
            raise HttpError(400, "status is required")
        status = clean_line(status, MAX_STATUS)
        snap = self._set_status(status)
        log(f"status: {status}")
        self._send_json(200, {"ok": True, "status": snap})

    def _api_draw(self):
        body = self._read_json()
        svg = body.get("svg")
        if not isinstance(svg, str) or "<svg" not in svg.lower():
            raise HttpError(400, "svg (string containing an <svg> element) is required")
        if len(svg.encode("utf-8")) > MAX_SVG:
            raise HttpError(413, "svg too large (max 2 MB)")
        item_id = body.get("id")
        if item_id is not None:
            if not isinstance(item_id, str) or not DRAW_ID_RE.match(item_id):
                raise HttpError(400, "id must match [A-Za-z0-9_.:-]{1,64}")
        else:
            item_id = "d-" + secrets.token_hex(4)
        width = num(body.get("width"))
        height = num(body.get("height"))
        label = body.get("label")
        item = {
            "id": item_id,
            "svg": svg,
            "x": num(body.get("x"), 0.0),
            "y": num(body.get("y"), 0.0),
            "width": width if width and width > 0 else None,
            "height": height if height and height > 0 else None,
            "label": clean_line(label, 200) if isinstance(label, str) and label.strip() else None,
            "ts": now_ms(),
        }
        st = self.store
        with st.lock:
            for i, old in enumerate(st.layer):
                if isinstance(old, dict) and old.get("id") == item_id:
                    st.layer[i] = item
                    break
            else:
                st.layer.append(item)
            st.save_layer()
        log(f"draw {item_id} at ({item['x']:.0f},{item['y']:.0f})")
        self.hub.broadcast("draw", item)
        self._send_json(200, {"id": item_id})

    def _api_draw_clear(self):
        self._read_json()
        st = self.store
        with st.lock:
            n = len(st.layer)
            st.layer = []
            st.save_layer()
        self.hub.broadcast("draw_clear", {})
        self._send_json(200, {"ok": True, "removed": n})

    def _api_draw_remove(self):
        body = self._read_json()
        item_id = body.get("id")
        if not isinstance(item_id, str) or not item_id:
            raise HttpError(400, "id is required")
        self._remove_draw(item_id)

    def _remove_draw(self, item_id: str):
        st = self.store
        with st.lock:
            before = len(st.layer)
            st.layer = [it for it in st.layer if not (isinstance(it, dict) and it.get("id") == item_id)]
            removed = before - len(st.layer)
            if removed:
                st.save_layer()
        if not removed:
            raise HttpError(404, f"no Claude-layer item with id {item_id!r}")
        self.hub.broadcast("draw_remove", {"id": item_id})
        self._send_json(200, {"ok": True, "id": item_id})


class CanvasServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # on Windows SO_REUSEADDR would allow double-binding the port
    request_queue_size = 64

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        socketserver.TCPServer.server_bind(self)  # skip getfqdn() (slow on Windows)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError, socket.timeout)):
            return
        log("connection error:\n" + traceback.format_exc())


def main(argv=None) -> int:
    global QUIET
    ap = argparse.ArgumentParser(description="Canvas server (binds 127.0.0.1 only)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("CANVAS_PORT", "8765")))
    ap.add_argument("--quiet", action="store_true", help="only print the startup banner")
    args = ap.parse_args(argv)

    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ensure_dirs()
    token = load_or_create_token()
    Handler.store = Store()
    Handler.hub = Hub()
    Handler.token = token
    if talker_mod is not None:
        Handler.talker = talker_mod.Talker(os.path.join(DATA_DIR, "talker"), log=log,
                                           canvas_url=f"http://{HOST}:{args.port}")

        def warm_talker():  # start Haiku now so the first spoken turn doesn't pay the ~5 s cold start
            try:
                Handler.talker.turn("[voice talker starting up; nothing has been said yet. Don't speak or use any tool.]")
            except Exception as exc:
                log(f"talker warmup failed: {exc}")
        threading.Thread(target=warm_talker, daemon=True).start()

    try:
        httpd = CanvasServer((HOST, args.port), Handler)
    except OSError as e:
        print(f"error: cannot bind {HOST}:{args.port} ({e}). Is another canvas server running?",
              file=sys.stderr, flush=True)
        return 2

    write_json_atomic(SERVER_INFO, {"host": HOST, "port": args.port, "pid": os.getpid(),
                                    "started": datetime.now().isoformat(timespec="seconds")},
                      pretty=True)
    url = f"http://{HOST}:{args.port}/?k={urllib.parse.quote(token, safe='')}"
    print("Canvas server running", flush=True)
    print(f"  URL:    {url}", flush=True)
    print(f"  Token:  {token}", flush=True)
    print(f"  Events: {EVENTS_LOG}", flush=True)
    QUIET = args.quiet
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        Handler.hub.close_all()
        httpd.server_close()
        print("Canvas server stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
