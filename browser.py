"""Live browser cards: a real Chrome on this PC, streamed into a card on the canvas.

One Chrome (headless, its own profile under data/browser-profile, so sign-ins persist) runs while
any browser card exists. Each card is one tab. Chrome's screencast pushes a JPEG whenever the page
repaints; the newest frame is kept per tab and the canvas page long-polls for it. A finger on the
card becomes touch input in the tab (taps click, drags scroll, like a phone); full screen adds an
address bar, back / forward / reload, and typing.

Talks to Chrome over the DevTools protocol with the `websockets` package (pip install websockets).
Without it the rest of the canvas works and browser cards say so.
"""
from __future__ import annotations

import base64
import json
import os
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.request

try:
    from websockets.sync.client import connect as ws_connect
except Exception:  # pragma: no cover
    ws_connect = None

VIEW_W, VIEW_H = 1280, 800  # the tab's viewport (a laptop-sized page); the card keeps this shape
CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
]
KEYS = {  # key name -> (code, windows virtual key code)
    "Enter": ("Enter", 13), "Backspace": ("Backspace", 8), "Tab": ("Tab", 9), "Escape": ("Escape", 27),
    "ArrowLeft": ("ArrowLeft", 37), "ArrowUp": ("ArrowUp", 38), "ArrowRight": ("ArrowRight", 39),
    "ArrowDown": ("ArrowDown", 40), "Delete": ("Delete", 46),
}


def find_chrome() -> str | None:
    for p in CHROME_PATHS:
        if os.path.isfile(p):
            return p
    for name in ("google-chrome", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


class Tab:
    """One browser card: a Chrome tab, its newest frame, and its input."""

    def __init__(self, bid: str, target: dict, log):
        self.id = bid
        self.target = target["id"]
        self.log = log
        self.url = target.get("url") or ""
        self.title = target.get("title") or ""
        self.frame = b""
        self.seq = 0
        self.cond = threading.Condition()
        self.alive = True
        self.ws = ws_connect(target["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024, open_timeout=10)
        self.send_lock = threading.Lock()
        self.msg_id = 0
        self.title_asks = set()  # ids of our own document.title requests
        threading.Thread(target=self._read, daemon=True, name=f"tab-{bid}").start()
        self.call("Page.enable")
        self.call("Emulation.setDeviceMetricsOverride", width=VIEW_W, height=VIEW_H, deviceScaleFactor=1, mobile=False)
        self.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=1)
        self.call("Page.startScreencast", format="jpeg", quality=62, maxWidth=VIEW_W, maxHeight=VIEW_H, everyNthFrame=1)
        self._ask_title()  # it may have loaded before we connected (no load event left to see)

    def call(self, method: str, **params) -> int:
        with self.send_lock:
            self.msg_id += 1
            try:
                self.ws.send(json.dumps({"id": self.msg_id, "method": method, "params": params}))
            except Exception:
                self.alive = False
            return self.msg_id

    def _ask_title(self) -> None:
        self.title_asks.add(self.call("Runtime.evaluate", expression="document.title"))

    def _changed(self) -> None:
        """The title or address changed: hand out the newest picture again with them, so a card
        whose page doesn't repaint still shows where it is."""
        with self.cond:
            if self.frame:
                self.seq += 1
                self.cond.notify_all()

    def _read(self) -> None:
        try:
            for raw in self.ws:
                msg = json.loads(raw)
                method = msg.get("method")
                if method == "Page.screencastFrame":
                    p = msg["params"]
                    with self.cond:
                        self.frame = base64.b64decode(p["data"])
                        self.seq += 1
                        self.cond.notify_all()
                    self.call("Page.screencastFrameAck", sessionId=p["sessionId"])
                elif method == "Page.frameNavigated":
                    fr = msg["params"].get("frame") or {}
                    if not fr.get("parentId") and fr.get("url") and fr["url"] != self.url:
                        self.url = fr["url"]
                        self._changed()
                elif method == "Page.navigatedWithinDocument":
                    url = msg["params"].get("url")
                    if url and url != self.url:
                        self.url = url
                        self._changed()
                    self._ask_title()
                elif method in ("Page.domContentEventFired", "Page.loadEventFired"):
                    self._ask_title()
                elif msg.get("id") in self.title_asks:
                    self.title_asks.discard(msg["id"])
                    v = ((msg.get("result") or {}).get("result") or {}).get("value")
                    if isinstance(v, str) and v[:200] != self.title:
                        self.title = v[:200]
                        self._changed()
        except Exception:
            pass
        self.alive = False
        with self.cond:
            self.cond.notify_all()

    def next_frame(self, after: int, wait: float = 20.0):
        """The newest frame once it's newer than `after` (waits up to `wait` s): (seq, jpeg)."""
        deadline = time.monotonic() + wait
        with self.cond:
            while self.alive and self.seq <= after:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                self.cond.wait(left)
            return self.seq, self.frame

    def input(self, ev: dict) -> None:
        kind = ev.get("kind")
        x = max(0.0, min(VIEW_W, float(ev.get("x") or 0)))
        y = max(0.0, min(VIEW_H, float(ev.get("y") or 0)))
        if kind in ("down", "move", "up"):  # a finger: touch input, so drags scroll like a phone
            t = {"down": "touchStart", "move": "touchMove", "up": "touchEnd"}[kind]
            self.call("Input.dispatchTouchEvent", type=t, touchPoints=[] if kind == "up" else [{"x": x, "y": y}])
        elif kind == "wheel":
            self.call("Input.dispatchMouseEvent", type="mouseWheel", x=x, y=y,
                      deltaX=float(ev.get("dx") or 0), deltaY=float(ev.get("dy") or 0))
        elif kind == "text" and isinstance(ev.get("text"), str):
            self.call("Input.insertText", text=ev["text"][:2000])
        elif kind == "key" and ev.get("key") in KEYS:
            code, vk = KEYS[ev["key"]]
            for t in ("rawKeyDown", "keyUp"):
                self.call("Input.dispatchKeyEvent", type=t, key=ev["key"], code=code,
                          windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk,
                          **({"text": "\r"} if ev["key"] == "Enter" and t == "rawKeyDown" else {}))
        elif kind == "nav" and isinstance(ev.get("url"), str):
            self.call("Page.navigate", url=normalize_url(ev["url"]))
        elif kind in ("back", "forward"):
            self.call("Runtime.evaluate", expression=f"history.{kind}()")
        elif kind == "reload":
            self.call("Page.reload")

    def close(self) -> None:
        self.alive = False
        try:
            self.ws.close()
        except Exception:
            pass


def normalize_url(text: str) -> str:
    t = text.strip()
    if "://" in t or t.startswith(("about:", "data:")):
        return t
    if " " in t or "." not in t:  # words: search for them
        return "https://www.google.com/search?q=" + urllib.request.quote(t)
    return "https://" + t


class BrowserManager:
    """The one Chrome and its tabs (browser cards), started on first use."""

    def __init__(self, data_dir: str, log):
        self.data_dir = data_dir
        self.log = log
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.port = 0
        self.tabs: dict[str, Tab] = {}

    @property
    def available(self) -> str | None:
        """None if browser cards can work here, else why not."""
        if ws_connect is None:
            return "browser cards need the websockets package: pip install websockets"
        if not find_chrome():
            return "browser cards need Google Chrome or Chromium on the PC"
        return None

    def _chrome(self) -> None:
        if self.proc and self.proc.poll() is None:
            return
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        profile = os.path.join(self.data_dir, "browser-profile")
        os.makedirs(profile, exist_ok=True)
        args = [find_chrome(), "--headless=new", f"--remote-debugging-port={self.port}",
                "--remote-debugging-address=127.0.0.1", f"--user-data-dir={profile}", "--no-first-run",
                "--no-default-browser-check", f"--window-size={VIEW_W},{VIEW_H}", "--hide-scrollbars",
                "--disable-features=Translate", "about:blank"]
        flags = 0x08000000 if os.name == "nt" else 0  # no window
        self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, creationflags=flags)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/version", timeout=1).read()
                self.log(f"browser: Chrome up (pid {self.proc.pid})")
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("Chrome didn't start")

    def open(self, url: str, bid: str | None = None) -> Tab:
        why = self.available
        if why:
            raise RuntimeError(why)
        with self.lock:
            self._chrome()
            bid = bid or "br-" + secrets.token_hex(4)
            old = self.tabs.pop(bid, None)
            if old:
                old.close()
            req = urllib.request.Request(f"http://127.0.0.1:{self.port}/json/new?{urllib.request.quote(normalize_url(url), safe=':/?&=%#')}",
                                         method="PUT")
            target = json.loads(urllib.request.urlopen(req, timeout=10).read().decode("utf-8"))
            tab = Tab(bid, target, self.log)
            self.tabs[bid] = tab
            self.log(f"browser: {bid} -> {url}")
            return tab

    def get(self, bid: str) -> Tab | None:
        tab = self.tabs.get(bid)
        return tab if tab and tab.alive else None

    def close(self, bid: str) -> None:
        with self.lock:
            tab = self.tabs.pop(bid, None)
        if not tab:
            return
        tab.close()
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/close/{tab.target}", timeout=5).read()
        except Exception:
            pass
        if not self.tabs and self.proc and self.proc.poll() is None:  # the last card: stop Chrome
            self.proc.terminate()
            self.proc = None

    def shutdown(self) -> None:
        for bid in list(self.tabs):
            self.close(bid)
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
