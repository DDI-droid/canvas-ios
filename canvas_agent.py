#!/usr/bin/env python3
"""Attach a Claude Code session to the user's iPad canvas.

A canvas *session* is one board + chat. Each Claude session owns one and talks to it over
HTTP(S), so this works from the same PC, another machine, or a cloud sandbox: anywhere the
canvas link is reachable. Python 3.8+, standard library only.

  python canvas_agent.py connect "<canvas link with ?k=...>" --session NAME [--title "..."]
  python canvas_agent.py wait   -s NAME [--timeout SECONDS]   # blocks until the next message
  python canvas_agent.py say    -s NAME [--file reply.md | text ... | -] [--status S]
  python canvas_agent.py status -s NAME "Running the sweep..."
  python canvas_agent.py draw   -s NAME --svg fig.svg --x X --y Y [--width W] [--id ID] [--label L]
  python canvas_agent.py draw   -s NAME --list | --remove ID | --clear
  python canvas_agent.py sessions

The link (with its secret key) is saved in ~/.canvas_agent/config.json by `connect`, or taken
from $CANVAS_LINK. Get the full instructions from <canvas origin>/agent?k=<key>&s=<name>.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.join(os.path.expanduser("~"), ".canvas_agent")
CONFIG = os.path.join(HOME, "config.json")
UA = "canvas-agent/1.0"


# --------------------------------------------------------------------------- plumbing
def die(msg: str, code: int = 1):
    print(f"error: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def parse_link(link: str) -> dict:
    parts = urllib.parse.urlsplit(link.strip())
    key = urllib.parse.parse_qs(parts.query).get("k", [""])[0]
    if parts.scheme not in ("http", "https") or not parts.netloc or not key:
        die("that doesn't look like a canvas link: it should be http(s)://host/?k=<key>")
    return {"origin": f"{parts.scheme}://{parts.netloc}", "key": key}


def load_config() -> dict:
    env = os.environ.get("CANVAS_LINK")
    if env:
        return parse_link(env)
    try:
        with open(CONFIG, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if cfg.get("origin") and cfg.get("key"):
            return cfg
    except (OSError, ValueError):
        pass
    die("not connected yet: run `python canvas_agent.py connect \"<canvas link>\" --session NAME`")


def save_json(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def state_path(sid: str) -> str:
    return os.path.join(HOME, f"session-{sid}.json")


def load_state(sid: str) -> dict:
    try:
        with open(state_path(sid), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def opener_for(origin: str):
    host = urllib.parse.urlsplit(origin).hostname or ""
    if host in ("127.0.0.1", "localhost", "::1"):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never proxy localhost
    return urllib.request.build_opener()  # honours HTTPS_PROXY in sandboxes


def request(cfg: dict, sid: str | None, method: str, path: str, payload=None, timeout: float = 30,
            raw: bool = False):
    headers = {"X-Canvas-Key": cfg["key"], "User-Agent": UA, "Accept": "application/json"}
    if sid:
        headers["X-Canvas-Session"] = sid
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(cfg["origin"] + path, data=data, method=method, headers=headers)
    with opener_for(cfg["origin"]).open(req, timeout=timeout) as r:
        body = r.read()
    if raw:
        return body
    text = body.decode("utf-8")
    return json.loads(text) if text.strip() else {}


def call(cfg: dict, sid: str | None, method: str, path: str, payload=None, timeout: float = 30):
    try:
        return request(cfg, sid, method, path, payload, timeout)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            body = json.loads(body).get("error", body)
        except ValueError:
            pass
        die(f"HTTP {e.code} from {path}: {body}")
    except (urllib.error.URLError, OSError) as e:
        die(f"can't reach the canvas at {cfg['origin']} ({getattr(e, 'reason', e)}). Is the server and "
            "its tunnel running on the user's PC? Has the link changed?")


def read_text(args) -> str:
    if getattr(args, "file", None):
        with open(args.file, "rb") as f:
            return f.read().decode("utf-8-sig")
    if args.text and args.text != ["-"]:
        return " ".join(args.text)
    if sys.stdin is None or sys.stdin.isatty():
        die("no text given (pass text, '-' with stdin, or --file)")
    return sys.stdin.buffer.read().decode("utf-8-sig")


# --------------------------------------------------------------------------- commands
def cmd_connect(args) -> None:
    cfg = parse_link(args.link)
    call(cfg, None, "GET", "/api/ping")
    sess = call(cfg, None, "POST", "/api/sessions", {"title": args.title or args.session, "id": args.session})
    save_json(CONFIG, cfg)
    sid = sess["id"]
    # start from "now": earlier messages in this session are history, not work
    res = call(cfg, sid, "GET", "/api/agent/next?wait=0", timeout=15)
    save_json(state_path(sid), {"after": res.get("latest") or ""})
    print(f"connected to canvas session '{sid}' ({sess.get('title')}) at {cfg['origin']}")
    print(f"next: run `python {os.path.basename(sys.argv[0])} wait -s {sid}` in the background, and")
    print(f"      reply with `python {os.path.basename(sys.argv[0])} say -s {sid} --file reply.md`")


def cmd_wait(args) -> None:
    cfg = load_config()
    sid = args.session
    after = load_state(sid).get("after", "")
    deadline = time.time() + args.timeout if args.timeout else None
    failures = 0
    while True:
        try:
            q = urllib.parse.urlencode({"after": after, "wait": 25})
            res = request(cfg, sid, "GET", f"/api/agent/next?{q}", timeout=45)
            failures = 0
        except urllib.error.HTTPError as e:
            if e.code in (401, 404):
                die(f"HTTP {e.code}: " + e.read().decode("utf-8", "replace")[:200])
            res, failures = None, failures + 1
        except (urllib.error.URLError, OSError):
            res, failures = None, failures + 1
        if res is None:
            if failures >= 20:  # about 5 minutes of a dead link
                die(f"lost the canvas at {cfg['origin']} (server or tunnel down, or the link changed)")
            time.sleep(min(30, 2 * failures))
            continue
        msg = res.get("message")
        if msg:
            break
        after = res.get("latest") or after
        save_json(state_path(sid), {"after": after})
        if deadline and time.time() > deadline:
            print("no message yet (timed out); run wait again")
            sys.exit(2)

    save_json(state_path(sid), {"after": msg["id"]})
    snap = None
    if msg.get("snapshot"):
        try:
            png = request(cfg, sid, "GET", msg["snapshot"], timeout=60, raw=True)
            snap = os.path.join(HOME, "inbox", sid, f"{msg['id']}.png")
            os.makedirs(os.path.dirname(snap), exist_ok=True)
            with open(snap, "wb") as f:
                f.write(png)
        except (urllib.error.URLError, OSError) as e:
            snap = f"(couldn't download the snapshot: {e})"
    print(f"MSG {msg['id']} | session {sid}")
    print("--- text ---")
    print(msg.get("text") or "(no text: look at the board)")
    print("--- board snapshot ---")
    print(snap or "(none)")
    print("--- timeline ---")
    print((msg.get("timeline") or "").strip())
    print("---")
    print(f"reply: python {os.path.basename(sys.argv[0])} say -s {sid} --file reply.md, then wait again")


def cmd_say(args) -> None:
    cfg = load_config()
    text = read_text(args)
    if not text.strip():
        die("empty reply")
    payload = {"text": text}
    if args.status:
        payload["status"] = args.status
    res = call(cfg, args.session, "POST", "/api/reply", payload)
    print(f"delivered reply {res.get('id')} ({len(text)} chars)")


def cmd_status(args) -> None:
    cfg = load_config()
    call(cfg, args.session, "POST", "/api/status", {"status": " ".join(args.text)})
    print("status set")


def cmd_draw(args) -> None:
    cfg = load_config()
    sid = args.session
    if args.list:
        layer = (call(cfg, sid, "GET", "/api/state") or {}).get("claude_layer") or []
        for it in layer:
            print(f"{it.get('id')}: x={it.get('x')} y={it.get('y')} width={it.get('width')} label={it.get('label')!r}")
        return
    if args.clear:
        res = call(cfg, sid, "POST", "/api/draw/clear", {})
        print(f"cleared {res.get('removed', 0)} drawing(s)")
        return
    if args.remove:
        call(cfg, sid, "POST", "/api/draw/remove", {"id": args.remove})
        print(f"removed {args.remove}")
        return
    if not args.svg:
        die("give --svg file.svg (or --list / --remove ID / --clear)")
    with open(args.svg, "rb") as f:
        svg = f.read().decode("utf-8-sig")
    payload = {"svg": svg, "x": args.x, "y": args.y, "width": args.width, "height": args.height,
               "id": args.id, "label": args.label}
    res = call(cfg, sid, "POST", "/api/draw", {k: v for k, v in payload.items() if v is not None})
    print(f"drew {res.get('id')} at ({args.x}, {args.y})")


def cmd_sessions(args) -> None:
    cfg = load_config()
    for s in (call(cfg, None, "GET", "/api/sessions") or {}).get("sessions") or []:
        mark = "connected" if s.get("agent") else "no agent"
        print(f"{s['id']:<20} {s.get('title', '')!r:<34} {mark}")


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="Attach a Claude session to the user's iPad canvas")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def with_session(p):
        p.add_argument("-s", "--session", required=True, help="your canvas session id")
        return p

    p = sub.add_parser("connect", help="save the canvas link and create/join a session")
    p.add_argument("link", help="the canvas link: https://host/?k=<key>")
    p.add_argument("-s", "--session", required=True, help="session id: lowercase letters, digits, dashes")
    p.add_argument("--title", help="a short title shown in the canvas session switcher")
    p.set_defaults(fn=cmd_connect)

    p = with_session(sub.add_parser("wait", help="block until the user's next message, then print it"))
    p.add_argument("--timeout", type=float, default=0, help="give up after this many seconds (default: never)")
    p.set_defaults(fn=cmd_wait)

    p = with_session(sub.add_parser("say", help="reply in the canvas chat (markdown + KaTeX)"))
    p.add_argument("text", nargs="*")
    p.add_argument("--file", "-f")
    p.add_argument("--status", help="status to show after the reply (default: idle)")
    p.set_defaults(fn=cmd_say)

    p = with_session(sub.add_parser("status", help="show a progress line in the canvas"))
    p.add_argument("text", nargs="+")
    p.set_defaults(fn=cmd_status)

    p = with_session(sub.add_parser("draw", help="place / list / remove SVG drawings on the board"))
    p.add_argument("--svg")
    p.add_argument("--x", type=float, default=0.0)
    p.add_argument("--y", type=float, default=0.0)
    p.add_argument("--width", type=float)
    p.add_argument("--height", type=float)
    p.add_argument("--id")
    p.add_argument("--label")
    p.add_argument("--list", action="store_true")
    p.add_argument("--remove")
    p.add_argument("--clear", action="store_true")
    p.set_defaults(fn=cmd_draw)

    p = sub.add_parser("sessions", help="list the canvas sessions")
    p.set_defaults(fn=cmd_sessions)

    args = ap.parse_args()
    if getattr(args, "session", None):
        args.session = args.session.strip().lower()
    args.fn(args)


if __name__ == "__main__":
    main()
