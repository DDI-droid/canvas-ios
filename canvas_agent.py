#!/usr/bin/env python3
"""Attach a Claude Code session to the user's iPad canvas.

A canvas *session* is one board + chat. Each Claude session owns one and talks to it over
HTTP(S), so this works from the same PC, another machine, or a cloud sandbox: anywhere the
canvas link is reachable. Python 3.8+, standard library only.

  python canvas_agent.py connect "<canvas link with ?k=...>" --session NAME [--title "..."]
  python canvas_agent.py wait   -s NAME [--timeout SECONDS]   # blocks until the next message
  python canvas_agent.py say    -s NAME [--file reply.md | text ... | -] [--status S]
  python canvas_agent.py note   -s NAME "Reading the training script"  # one step of progress
  python canvas_agent.py status -s NAME "Running the sweep..."
  python canvas_agent.py draw   -s NAME --svg fig.svg --x X --y Y [--width W] [--id ID] [--label L]
  python canvas_agent.py draw   -s NAME --list | --remove ID | --clear
  python canvas_agent.py embed  -s NAME --file chart.png|clip.mp4|part.glb [--x X --y Y --width W] [--label L] [--id ID]
  python canvas_agent.py page   -s NAME --file demo.html [--label L]     # a live, interactive HTML card
  python canvas_agent.py chart  -s NAME --data d.json [--title T]       # {type, x, series: [{name, y}]}
  python canvas_agent.py model  -s NAME --file part.glb|.gltf|.obj|.stl  # a 3D model you can turn
  python canvas_agent.py update -s NAME --id CARD --data d.json [--append]  # live data for a card
  python canvas_agent.py browse -s NAME --url example.com [--label L]   # a live browser card
  python canvas_agent.py signin [--url accounts.google.com]             # sign the browser cards in, on the PC
  python canvas_agent.py sessions

The link (with its secret key) is saved in ~/.canvas_agent/config.json by `connect`, or taken
from $CANVAS_LINK. Get the full instructions from <canvas origin>/agent?k=<key>&s=<name>.
"""
from __future__ import annotations

import argparse
import base64
import json
import struct
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


def remember_attachment(sid: str) -> None:
    """Record which canvas session this Claude Code session works in. The chat-mirror hooks
    (canvas/hooks/) use it to copy prompts typed in Claude Code, and the answers to them, into
    that session's canvas chat, so the canvas reads like the whole conversation. Only `wait`
    and `connect` call this: they're what "attached" means (one-off commands like `embed` from
    a test script must not steal the mirror)."""
    cid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not cid or not sid:
        return
    path = os.path.join(HOME, "attached.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    now = int(time.time())
    cur = data.get(cid)
    if isinstance(cur, dict) and cur.get("session") == sid and now - int(cur.get("ts", 0)) < 600:
        return
    keep_mirror = isinstance(cur, dict) and cur.get("session") == sid and cur.get("mirror")
    data[cid] = {"session": sid, "ts": now, **({"mirror": True} if keep_mirror else {})}
    data = {k: v for k, v in data.items() if isinstance(v, dict) and now - int(v.get("ts", 0)) < 30 * 86400}
    try:
        save_json(path, data)
    except OSError:
        pass


def opener_for(origin: str):
    host = urllib.parse.urlsplit(origin).hostname or ""
    if host in ("127.0.0.1", "localhost", "::1"):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never proxy localhost
    return urllib.request.build_opener()  # honours HTTPS_PROXY in sandboxes


def is_local(origin: str) -> bool:
    return (urllib.parse.urlsplit(origin).hostname or "") in ("127.0.0.1", "localhost", "::1")


def follow(cfg: dict) -> bool:
    """The canvas's public address changed (its tunnel restarted): read where it is now from the
    secret gist the canvas publishes (address only, never the key) and switch to it. Saved, so
    later commands use it too. True if it moved."""
    reg = cfg.get("registry")
    if not reg or is_local(cfg["origin"]):
        return False
    try:
        req = urllib.request.Request(f"{reg}?t={int(time.time())}", headers={
            "Accept": "application/vnd.github+json", "User-Agent": UA})
        with urllib.request.build_opener().open(req, timeout=15) as r:
            gist = json.loads(r.read().decode("utf-8"))
        info = json.loads(gist["files"]["canvas-link.json"]["content"])
        parts = urllib.parse.urlsplit(info["url"])
        origin = f"{parts.scheme}://{parts.netloc}"
    except Exception:
        return False
    if parts.scheme != "https" or origin == cfg["origin"]:
        return False
    cfg["origin"] = origin
    if not os.environ.get("CANVAS_LINK"):
        save_json(CONFIG, cfg)
    print(f"(the canvas moved to {origin}; following it)", file=sys.stderr, flush=True)
    return True


def request(cfg: dict, sid: str | None, method: str, path: str, payload=None, timeout: float = 30,
            raw: bool = False):
    try:
        return _request(cfg, sid, method, path, payload, timeout, raw)
    except (urllib.error.URLError, OSError) as e:
        if isinstance(e, urllib.error.HTTPError) and e.code not in (502, 503, 504, 530):
            raise
        if follow(cfg):  # the address changed: try once more at the new one
            return _request(cfg, sid, method, path, payload, timeout, raw)
        raise


def _request(cfg: dict, sid: str | None, method: str, path: str, payload=None, timeout: float = 30,
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


def upload(cfg: dict, sid: str, path: str, mime: str, timeout: float = 1800) -> dict:
    """Send a file to the canvas as it is (no base64): images, videos, 3D models."""
    with open(path, "rb") as f:
        data = f.read()
    headers = {"X-Canvas-Key": cfg["key"], "X-Canvas-Session": sid, "User-Agent": UA,
               "Accept": "application/json", "Content-Type": mime}
    req = urllib.request.Request(cfg["origin"] + "/api/media", data=data, method="POST", headers=headers)
    try:
        with opener_for(cfg["origin"]).open(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        die(f"HTTP {e.code} uploading {os.path.basename(path)}: {e.read().decode('utf-8', 'replace')[:200]}")
    except (urllib.error.URLError, OSError) as e:
        die(f"can't reach the canvas at {cfg['origin']} ({getattr(e, 'reason', e)})")


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
def slug(text: str) -> str:
    s = "".join(ch if ch.isalnum() else "-" for ch in (text or "").lower())
    s = "-".join(p for p in s.split("-") if p)[:28].strip("-")
    return s if s and s[0].isalnum() else ("board-" + s).strip("-")


def pick_board(cfg: dict, wanted: str) -> str:
    """A board for this Claude session: `wanted`, or wanted-2, -3… if another Claude session is
    already listening on it (two listeners on one board would both answer every message)."""
    mine = None
    cid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if cid:
        try:
            with open(os.path.join(HOME, "attached.json"), "r", encoding="utf-8") as f:
                mine = (json.load(f).get(cid) or {}).get("session")
        except (OSError, ValueError, AttributeError):
            mine = None
    boards = {s["id"]: s for s in (call(cfg, None, "GET", "/api/sessions") or {}).get("sessions") or []}
    base = slug(wanted)
    for n in range(1, 50):
        sid = base if n == 1 else f"{base[:26]}-{n}"
        b = boards.get(sid)
        if b is None or sid == mine or not b.get("agent"):
            return sid
    die("too many boards with that name are in use")


def cmd_connect(args) -> None:
    cfg = parse_link(args.link) if args.link else load_config()
    call(cfg, None, "GET", "/api/ping")
    try:  # where the canvas publishes its address when it changes (see follow())
        reg = (call(cfg, None, "GET", "/api/link") or {}).get("registry")
        if reg:
            cfg["registry"] = reg
    except SystemExit:
        pass
    if args.auto:
        args.session = pick_board(cfg, args.auto)
    if not args.session:
        die("give a board: -s NAME, or --auto NAME")
    sess = call(cfg, None, "POST", "/api/sessions", {"title": args.title or args.auto or args.session, "id": args.session})
    if not os.environ.get("CANVAS_LINK"):
        save_json(CONFIG, cfg)
    sid = sess["id"]
    # start from "now": earlier messages in this session are history, not work
    res = call(cfg, sid, "GET", "/api/agent/next?wait=0", timeout=15)
    save_json(state_path(sid), {"after": res.get("latest") or ""})
    remember_attachment(sid)
    print(f"connected to canvas session '{sid}' ({sess.get('title')}) at {cfg['origin']}")
    print(f"next: run `python {os.path.basename(sys.argv[0])} wait -s {sid}` in the background, and")
    print(f"      reply with `python {os.path.basename(sys.argv[0])} say -s {sid} --file reply.md`")


def cmd_wait(args) -> None:
    cfg = load_config()
    sid = args.session
    remember_attachment(sid)
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
    print("--- changes since you last looked (change map) ---")
    print(board_picture(cfg, sid, "/api/board/changes?viewer=agent", f"{msg['id']}-changes"))
    print("---")
    print(f"reply: python {os.path.basename(sys.argv[0])} say -s {sid} --file reply.md, then wait again")


def board_picture(cfg, sid: str, path: str, name: str) -> str:
    """Fetch a picture the PC draws of the board (the change map, or a rectangle), save it next
    to the snapshots, and say where it is and what its tiles cover."""
    try:
        res = request(cfg, sid, "GET", path, timeout=60)
    except urllib.error.HTTPError as e:
        return f"(couldn't draw it: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:200]})"
    except (urllib.error.URLError, OSError) as e:
        return f"(couldn't draw it: {e})"
    if res.get("first_look"):
        return "(first look: from now on this shows what changed between your looks)"
    if not res.get("image"):
        return "(nothing changed since you last looked)"
    out = os.path.join(HOME, "inbox", sid, f"{name}.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(base64.b64decode(res["image"]))
    tiles = "\n".join(
        f"  #{t['n']}: world x {round(t['rect'][0])}..{round(t['rect'][2])}, y {round(t['rect'][1])}..{round(t['rect'][3])}"
        f" at pixels {t['px'][0]},{t['px'][1]} size {t['px'][2]}x{t['px'][3]} (world = rect start + px / {t['scale']})"
        for t in res.get("tiles") or [])
    return f"{out}\n{tiles}"


def cmd_look(args) -> None:
    cfg = load_config()
    if args.area:
        x0, y0, x1, y1 = args.area
        q = urllib.parse.urlencode({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "px": args.px})
        name = f"area-{int(time.time())}"
        print(board_picture(cfg, args.session, f"/api/board/area?{q}", name))
    else:
        name = f"changes-{int(time.time())}"
        print(board_picture(cfg, args.session, "/api/board/changes?viewer=agent", name))


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


def cmd_note(args) -> None:
    cfg = load_config()
    call(cfg, args.session, "POST", "/api/progress", {"text": " ".join(args.text)})
    print("noted")


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


IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
              ".webp": "image/webp", ".avif": "image/avif", ".heic": "image/heic"}
VIDEO_MIME = {".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".webm": "video/webm"}
MODEL_MIME = {".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".obj": "model/obj", ".stl": "model/stl"}


def image_size(raw: bytes):
    """(width, height) from a PNG, GIF or JPEG header, or None."""
    try:
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", raw[16:24])
        if raw[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", raw[6:10])
        if raw[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(raw):
                if raw[i] != 0xFF:
                    i += 1
                    continue
                marker = raw[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", raw[i + 5:i + 9])
                    return w, h
                seg = struct.unpack(">H", raw[i + 2:i + 4])[0]
                i += 2 + seg
    except struct.error:
        pass
    return None


def card_place(args) -> dict:
    return {k: v for k, v in (("x", args.x), ("y", args.y), ("width", args.width), ("id", args.id),
                              ("label", args.label)) if v is not None}


def cmd_embed(args) -> None:
    """An image, a video or a 3D model as a card (by its file type)."""
    ext = os.path.splitext(args.file)[1].lower()
    if ext in MODEL_MIME:
        return cmd_model(args)
    cfg = load_config()
    if ext in VIDEO_MIME:
        up = upload(cfg, args.session, args.file, VIDEO_MIME[ext])
        # its real shape and first frame are filled in by the first page that shows it
        res = call(cfg, args.session, "POST", "/api/draw", {"type": "video", "src": up["src"], "aspect": 9 / 16, **card_place(args)})
        print(f"embedded video {res.get('id')} ({up.get('bytes', 0) / 1e6:.1f} MB): tap to play, double-tap for full screen")
        return
    mime = IMAGE_MIME.get(ext)
    if not mime:
        die("images (png, jpg, gif, webp, avif, heic), videos (mp4, mov, m4v, webm) or 3D models (glb, gltf, obj, stl)")
    with open(args.file, "rb") as f:
        raw = f.read()
    up = upload(cfg, args.session, args.file, mime)
    payload = {"type": "image", "src": up["src"], **card_place(args)}
    size = image_size(raw)
    if size and size[0]:
        payload["aspect"] = size[1] / size[0]
    res = call(cfg, args.session, "POST", "/api/draw", payload)
    print(f"embedded {res.get('id')} at ({res.get('x', 0):.0f}, {res.get('y', 0):.0f}), "
          f"width {res.get('width', 0):.0f} (double-tap it on the iPad to open full screen)")


def _page_card(cfg, args, page: dict, aspect: float) -> None:
    res = call(cfg, args.session, "POST", "/api/draw", {"type": "page", "page": page["page"], "aspect": aspect, **card_place(args)})
    print(f"card {res.get('id')} (page {page['page']}): live on the board; "
          f"update its data with: update -s {args.session} --id {res.get('id')} --data new.json")


def cmd_page(args) -> None:
    """A live HTML page as a card: interactive in place (a finger uses it) and full screen.
    It runs sandboxed; it can load /vendor/three/... and /vendor/chartjs/... from the canvas, or
    libraries from the web. Live data: window.addEventListener('canvas:data', e => e.detail.data)."""
    cfg = load_config()
    with open(args.file, "rb") as f:
        html = f.read().decode("utf-8-sig")
    page = call(cfg, args.session, "POST", "/api/page", {"html": html, "title": args.label or os.path.basename(args.file)})
    _page_card(cfg, args, page, args.aspect or 0.66)


def cmd_chart(args) -> None:
    """A chart card from data: {type: line|bar|scatter|area, title?, x: [...], series: [{name, y: [...]}],
    xLabel?, yLabel?}. Grows live with: update --append --data {x: [...], series: [{name, y: [...]}]}."""
    cfg = load_config()
    with open(args.data, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if args.type:
        data["type"] = args.type
    if args.title:
        data["title"] = args.title
    page = call(cfg, args.session, "POST", "/api/page", {"template": "chart", "data": data, "title": data.get("title") or args.label})
    args.label = args.label or data.get("title")
    _page_card(cfg, args, page, args.aspect or 0.62)


def cmd_model(args) -> None:
    """A 3D model card (glb, gltf, obj, stl): turn it with a finger; it turns slowly by itself until touched."""
    cfg = load_config()
    ext = os.path.splitext(args.file)[1].lower()
    if ext not in MODEL_MIME:
        die("3D models: glb, gltf (single file), obj or stl")
    up = upload(cfg, args.session, args.file, MODEL_MIME[ext])
    name = up["src"].rsplit("/", 1)[1]
    page = call(cfg, args.session, "POST", "/api/page", {"template": "model", "data": {"src": f"media/{name}"},
                                                        "title": args.label or os.path.basename(args.file)})
    args.label = args.label or os.path.splitext(os.path.basename(args.file))[0]
    _page_card(cfg, args, page, getattr(args, "aspect", None) or 0.75)


def cmd_update(args) -> None:
    """New data for a live card (chart or page). --append adds points to a chart."""
    cfg = load_config()
    with open(args.data, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    call(cfg, args.session, "POST", "/api/card/data", {"id": args.id, "data": data, "mode": "append" if args.append else "replace"})
    print("updated")


def cmd_signin(args) -> None:
    """Sites like Google won't sign in a hidden browser: open a normal Chrome window on the PC
    with the browser cards' profile. Sign in there and close the window; the cards come back
    signed in."""
    cfg = load_config()
    call(cfg, args.session, "POST", "/api/browser/signin", {"url": args.url} if args.url else {}, timeout=60)
    print("A Chrome window is open on the PC that runs the canvas. Sign in there, then close the "
          "window: the browser cards come back signed in. (They pause until it's closed.)")


def cmd_browse(args) -> None:
    """A live browser card: a real Chrome tab on the canvas's PC, streamed into the card."""
    cfg = load_config()
    res = call(cfg, args.session, "POST", "/api/browser", {"url": args.url, **card_place(args)}, timeout=60)
    print(f"browser card {res.get('id')} -> {args.url}: tap and scroll it on the iPad, double-tap for full screen")


def cmd_setup(args) -> None:
    """Can this machine reach a canvas? One line for the /canvas:connect skill:
       CANVAS ok <origin>       a canvas is configured and answering
       CANVAS down <origin>     configured, but not answering (the PC hosting it is off?)
       CANVAS none              nothing configured: ask the user for their canvas link
    With --host: start a canvas on this machine (server + tunnel, data in ~/.canvas) and use it."""
    if args.host:
        return host_here()
    cfg = None
    try:
        with open(CONFIG, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        pass
    if os.environ.get("CANVAS_LINK"):
        cfg = parse_link(os.environ["CANVAS_LINK"])
    if not cfg or not cfg.get("origin") or not cfg.get("key"):
        print("CANVAS none")
        return
    try:
        request(cfg, None, "GET", "/api/ping", timeout=10)
        print(f"CANVAS ok {cfg['origin']}")
    except Exception:
        print(f"CANVAS down {cfg['origin']}")


def host_here() -> None:
    """Start a canvas on this machine with the supervisor that ships next to this file, data in
    ~/.canvas (kept across plugin updates), and connect this machine to it."""
    import subprocess
    here = os.path.dirname(os.path.abspath(__file__))
    data = os.environ.get("CANVAS_DATA") or os.path.join(os.path.expanduser("~"), ".canvas")
    os.makedirs(data, exist_ok=True)
    env = dict(os.environ, CANVAS_DATA=data)
    py = sys.executable
    if os.name == "nt":
        pyw = os.path.join(os.path.dirname(py), "pythonw.exe")
        py = pyw if os.path.isfile(pyw) else py
        subprocess.Popen([py, os.path.join(here, "supervisor.py")], env=env, cwd=here,
                         creationflags=0x00000008 | 0x00000200)  # detached, own process group
    else:
        subprocess.Popen([py, os.path.join(here, "supervisor.py")], env=env, cwd=here,
                         start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    token = os.path.join(data, "token.txt")
    for _ in range(60):
        if os.path.isfile(token):
            try:
                cfg = {"origin": "http://127.0.0.1:8765", "key": open(token, encoding="utf-8").read().strip()}
                _request(cfg, None, "GET", "/api/ping", timeout=3)
                save_json(CONFIG, cfg)
                print(f"CANVAS ok {cfg['origin']} (started here; data in {data})")
                return
            except Exception:
                pass
        time.sleep(1)
    die("started the canvas, but it isn't answering yet: see ~/.canvas/supervisor.log")


def cmd_link(args) -> None:
    """The link to paste into a new iPad (Canvas › Server link…) or a Claude session on another
    machine (/canvas:connect asks for it). It contains the canvas's secret key: share it only
    with your own devices."""
    cfg = load_config()
    info = call(cfg, None, "GET", "/api/link") or {}
    base = info.get("public") or cfg["origin"]
    print(f"{base}/?k={urllib.parse.quote(cfg['key'], safe='')}")
    if not info.get("public"):
        print("(that's this machine's own address: it only works here. Start the supervisor for a public one.)")


def cmd_mirror(args) -> None:
    """Chat copying for this board: `on` / `off` (or no state: show it). While on, Claude copies
    each prompt typed in Claude Code, and its answer, into the board's chat with `copy`."""
    path = os.path.join(HOME, "attached.json")
    cid = os.environ.get("CLAUDE_CODE_SESSION_ID") or "manual"
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    if args.state is None:
        on = any(isinstance(v, dict) and v.get("session") == args.session and v.get("mirror") for v in data.values())
        print(f"chat copying is {'on' if on else 'off'} for board '{args.session}'")
        return
    data[cid] = {**(data.get(cid) or {}), "session": args.session, "ts": int(time.time()), "mirror": args.state == "on"}
    save_json(path, data)
    print(f"chat copying {'on' if args.state == 'on' else 'off'} for board '{args.session}'")


def cmd_copy(args) -> None:
    """Copy one exchange typed in Claude Code into the board's chat (only while copying is on):
    the user's prompt, then the answer. Each from a file, so markdown and $math$ arrive intact."""
    cfg = load_config()
    for role, path in (("user", args.prompt_file), ("claude", args.answer_file)):
        if not path:
            continue
        with open(path, "rb") as f:
            text = f.read().decode("utf-8-sig").strip()
        if text:
            call(cfg, args.session, "POST", "/api/mirror", {"role": role, "text": text})
    print("copied to the canvas chat")


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
    p.add_argument("link", nargs="?", help="the canvas link: https://host/?k=<key> (default: the saved one)")
    p.add_argument("-s", "--session", help="session id: lowercase letters, digits, dashes")
    p.add_argument("--auto", metavar="NAME", help="pick a free board named after NAME (adds -2, -3… if in use)")
    p.add_argument("--title", help="a short title shown in the canvas session switcher")
    p.set_defaults(fn=cmd_connect)

    p = sub.add_parser("setup", help="is a canvas reachable from here? (--host: start one on this machine)")
    p.add_argument("--host", action="store_true")
    p.set_defaults(fn=cmd_setup)

    p = sub.add_parser("link", help="print the link for a new iPad or another machine")
    p.set_defaults(fn=cmd_link)

    p = with_session(sub.add_parser("mirror", help="chat copying for this board: on / off (no state: show it)"))
    p.add_argument("state", nargs="?", choices=["on", "off"])
    p.set_defaults(fn=cmd_mirror)

    p = with_session(sub.add_parser("copy", help="copy one Claude Code exchange into the board's chat"))
    p.add_argument("--prompt-file", help="the user's prompt, as typed")
    p.add_argument("--answer-file", help="your answer")
    p.set_defaults(fn=cmd_copy)

    p = with_session(sub.add_parser("wait", help="block until the user's next message, then print it"))
    p.add_argument("--timeout", type=float, default=0, help="give up after this many seconds (default: never)")
    p.set_defaults(fn=cmd_wait)

    p = with_session(sub.add_parser("look", help="a picture of the board drawn on the PC: what changed since "
                                                  "you last looked (default), or any rectangle (--area)"))
    p.add_argument("--area", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"),
                   help="the world rectangle to draw (top left, bottom right)")
    p.add_argument("--px", type=int, default=1600, help="the picture's longest side in pixels (--area)")
    p.set_defaults(fn=cmd_look)

    p = with_session(sub.add_parser("say", help="reply in the canvas chat (markdown + KaTeX)"))
    p.add_argument("text", nargs="*")
    p.add_argument("--file", "-f")
    p.add_argument("--status", help="status to show after the reply (default: idle)")
    p.set_defaults(fn=cmd_say)

    p = with_session(sub.add_parser("note", help="post one short progress step to the chat"))
    p.add_argument("text", nargs="+")
    p.set_defaults(fn=cmd_note)

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

    p = with_session(sub.add_parser("embed", help="put an image, video or 3D model on the board as a card"))
    p.add_argument("--file", required=True, help="an image (png, jpg, gif, webp, avif, heic), video (mp4, mov, m4v, webm) or 3D model (glb, gltf, obj, stl)")
    p.add_argument("--x", type=float, help="world x (default: centred in the user's view)")
    p.add_argument("--y", type=float)
    p.add_argument("--width", type=float, help="world width (default: ~40%% of the view)")
    p.add_argument("--label")
    p.add_argument("--id")
    p.set_defaults(fn=cmd_embed)

    def placing(p):
        p.add_argument("--x", type=float, help="world x (default: centred in the user's view)")
        p.add_argument("--y", type=float)
        p.add_argument("--width", type=float, help="world width")
        p.add_argument("--label")
        p.add_argument("--id")
        return p

    p = placing(with_session(sub.add_parser("page", help="a live, interactive HTML page as a card")))
    p.add_argument("--file", required=True)
    p.add_argument("--aspect", type=float, help="height / width of the page area (default 0.66)")
    p.set_defaults(fn=cmd_page)

    p = placing(with_session(sub.add_parser("chart", help="a chart card from JSON data (updates live)")))
    p.add_argument("--data", required=True, help="{type, title?, x: [...], series: [{name, y: [...]}]}")
    p.add_argument("--type", choices=["line", "bar", "scatter", "area"])
    p.add_argument("--title")
    p.add_argument("--aspect", type=float)
    p.set_defaults(fn=cmd_chart)

    p = placing(with_session(sub.add_parser("model", help="a 3D model card (glb, gltf, obj, stl)")))
    p.add_argument("--file", required=True)
    p.add_argument("--aspect", type=float)
    p.set_defaults(fn=cmd_model)

    p = with_session(sub.add_parser("update", help="new data for a live card (chart / page)"))
    p.add_argument("--id", required=True, help="the card id")
    p.add_argument("--data", required=True, help="a JSON file")
    p.add_argument("--append", action="store_true", help="add points to a chart instead of replacing")
    p.set_defaults(fn=cmd_update)

    p = placing(with_session(sub.add_parser("browse", help="a live browser card (a real Chrome tab on the PC)")))
    p.add_argument("--url", required=True)
    p.set_defaults(fn=cmd_browse)

    p = sub.add_parser("signin", help="sign the browser cards in to a site (opens Chrome on the PC)")
    p.add_argument("--url", help="where to sign in (default accounts.google.com)")
    p.add_argument("-s", "--session", default=None)
    p.set_defaults(fn=cmd_signin)

    p = sub.add_parser("sessions", help="list the canvas sessions")
    p.set_defaults(fn=cmd_sessions)

    args = ap.parse_args()
    if getattr(args, "session", None):
        args.session = args.session.strip().lower()
    args.fn(args)


if __name__ == "__main__":
    main()
