"""Live browser cards: a real Chrome on this PC, streamed into a card on the canvas.

One Chrome (headless, its own profile under data/browser-profile, so sign-ins persist) runs while
any browser card exists. Each card is one tab. Chrome's screencast pushes a JPEG whenever the page
repaints; the newest frame is kept per tab and the canvas page long-polls for it. A finger on the
card becomes touch input in the tab (taps click, drags scroll, like a phone); full screen adds an
address bar, back / forward / reload, and typing.

It identifies itself as normal Chrome (user agent, client hints, no automation flag), so sites
treat it like any browser. Sites that still refuse a hidden browser's sign-in (Google): sign_in()
pauses it and opens a normal Chrome window on this PC with the same profile; sign in there, close
the window, and the cards come back signed in.

Links that would open a new tab (target=_blank, window.open) open in the same card, like a phone
browser: one card, one tab, no extra tiles.

Talks to Chrome over the DevTools protocol with the `websockets` package (pip install websockets).
Without it the rest of the canvas works and browser cards say so.
"""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
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


# In every page of a card: links and window.open stay in this tab (a card is one tab)
SAME_TAB_JS = r"""(() => {
  const same = (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const t = (a.getAttribute('target') || (document.querySelector('base[target]') || {}).target || '').toLowerCase();
    if (t && t !== '_self' && t !== '_top' && t !== '_parent') a.target = '_self';
  };
  addEventListener('click', same, true);
  addEventListener('auxclick', same, true);
  const open = window.open;
  window.open = function (u) {
    if (!u || u === 'about:blank') return open.apply(this, arguments);
    location.href = new URL(u, location.href).href;
    return window;
  };
})();"""


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

    def __init__(self, bid: str, target: dict, log, identity: dict | None = None, url: str | None = None):
        self.id = bid
        self.target = target["id"]
        self.log = log
        self.url = url or target.get("url") or ""
        self.title = "" if url else target.get("title") or ""
        self.popup = False      # opened by a page (a new tab / popup), not by the canvas
        self.last_input = 0.0   # when a finger last touched it (new tabs belong to that card)
        self.frame = b""
        self.seq = 0
        self.cond = threading.Condition()
        self.viewers: dict[str, tuple] = {}  # viewer -> (width, quality, last seen): what it can use
        self.cursors: dict[str, int] = {}     # viewer -> the last picture handed to it
        self.cast = (55, 960)                 # the screencast's (quality, max width) now
        self.cast_at = 0.0
        # Chrome makes pictures only while someone looks: a card on screen asking for them, or a
        # request waiting for the next one. Otherwise the screencast pauses (an animated page
        # would cost the PC most of a core for nobody) and picks up on the next request.
        self.casting = True
        self.watched_at = time.monotonic()    # when a viewer last asked for pictures
        self.waiting = 0                      # requests waiting for the next picture now
        self.alive = True
        self.ws = ws_connect(target["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024, open_timeout=10)
        self.send_lock = threading.Lock()
        self.msg_id = 0
        self.title_asks = set()  # ids of our own document.title requests
        threading.Thread(target=self._read, daemon=True, name=f"tab-{bid}").start()
        self.call("Page.enable")
        self.call("Page.addScriptToEvaluateOnNewDocument", source=SAME_TAB_JS)
        if identity:  # normal Chrome, before the first page loads
            self.call("Emulation.setUserAgentOverride", **identity)
        self.call("Emulation.setDeviceMetricsOverride", width=VIEW_W, height=VIEW_H, deviceScaleFactor=1, mobile=False)
        self.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=1)
        self._start_cast()
        threading.Thread(target=self._pause_when_unwatched, daemon=True, name=f"tab-idle-{bid}").start()
        if url:
            self.pending_url = url
            self.call("Page.navigate", url=url)
            # a fresh tab's own blank page can swallow the first navigation: check, and go again
            for delay in (4.0, 10.0, 20.0):
                threading.Timer(delay, self._ensure_loaded).start()
        else:
            self._ask_title()  # it may have loaded before we connected (no load event left to see)
            threading.Timer(1.5, self._ask_title).start()  # (or be just about to)

    def call(self, method: str, **params) -> int:
        with self.send_lock:
            self.msg_id += 1
            try:
                self.ws.send(json.dumps({"id": self.msg_id, "method": method, "params": params}))
            except Exception:
                self.alive = False
            return self.msg_id

    pending_url = None  # the address it was opened at, until it's really there

    def _ensure_loaded(self) -> None:
        if self.alive and self.pending_url and (not self.url or self.url == "about:blank"):
            self.log(f"browser: {self.id} still blank; loading {self.pending_url} again")
            self.call("Page.navigate", url=self.pending_url)

    def _start_cast(self) -> None:
        q, w = self.cast
        self.call("Page.startScreencast", format="jpeg", quality=q, maxWidth=w,
                  maxHeight=round(w * VIEW_H / VIEW_W), everyNthFrame=1)

    def want(self, viewer: str, width: int, quality: int) -> None:
        """A viewer's picture size and quality (what its card shows, what its link carries).
        Chrome makes pictures for the most demanding viewer that's still watching."""
        now = time.monotonic()
        with self.cond:
            self.viewers[viewer] = (width, quality, now)
            self.watched_at = now
            for v, (_, _, seen) in list(self.viewers.items()):
                if now - seen > 15:
                    self.viewers.pop(v, None)
                    self.cursors.pop(v, None)
            best = (max(x[1] for x in self.viewers.values()), max(x[0] for x in self.viewers.values()))
            if self.casting and (best == self.cast or now - self.cast_at < 1.0):
                return
            restart = self.casting
            self.cast, self.cast_at = best, now
            self.casting = True
        if restart:
            self.call("Page.stopScreencast")
        self._start_cast()

    UNWATCHED_S = 6.0

    def _pause_when_unwatched(self) -> None:
        while self.alive:
            time.sleep(2.0)
            with self.cond:
                pause = (self.casting and not self.waiting
                         and time.monotonic() - self.watched_at > self.UNWATCHED_S)
                if pause:
                    self.casting = False
            if pause:
                self.call("Page.stopScreencast")

    def _ask_title(self) -> None:
        self.title_asks.add(self.call("Runtime.evaluate", expression="[document.title, location.href]", returnByValue=True))

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
                        if self.url != "about:blank":
                            self.pending_url = None
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
                    if isinstance(v, list) and len(v) == 2 and all(isinstance(x, str) for x in v):
                        title, href = v[0][:200], v[1]
                        if title != self.title or (href and href != "about:blank" and href != self.url):
                            self.title = title
                            if href and href != "about:blank":
                                self.url = href  # a new tab may have loaded before we joined it
                            self._changed()
        except Exception:
            pass
        self.alive = False
        with self.cond:
            self.cond.notify_all()

    def next_frame(self, after: int, wait: float = 20.0, viewer: str | None = None):
        """The newest frame once it's newer than `after` (waits up to `wait` s): (seq, jpeg).
        With a viewer, each picture goes to one of its requests only (it keeps two in flight)."""
        deadline = time.monotonic() + wait
        with self.cond:
            resume = not self.casting  # paused while nobody looked: someone is looking now
            self.casting = True
        if resume:
            self._start_cast()
        with self.cond:
            self.waiting += 1
            try:
                if viewer:
                    after = max(after, self.cursors.get(viewer, 0))
                while self.alive and self.seq <= after:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    self.cond.wait(left)
                    if viewer:
                        after = max(after, self.cursors.get(viewer, 0))
                if viewer and self.seq > self.cursors.get(viewer, 0):
                    self.cursors[viewer] = self.seq
                return self.seq, self.frame
            finally:
                self.waiting -= 1
                self.watched_at = time.monotonic()

    def input(self, ev: dict) -> None:
        self.last_input = time.monotonic()
        kind = ev.get("kind")
        if kind not in ("move", "up", "wheel"):
            # a tab a page opened shares its window with the opener, and only a window's front tab
            # takes input and repaints: the one you touch comes to the front
            self.call("Page.bringToFront")
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


def chrome_user_agent() -> str | None:
    """Normal Chrome's user agent for the installed version (Chrome's reduced form), or None."""
    exe = find_chrome()
    if not exe:
        return None
    major = None
    try:  # Windows: the version is a folder next to chrome.exe
        vers = [n for n in os.listdir(os.path.dirname(exe)) if re.match(r"^\d+\.\d+\.\d+\.\d+$", n)]
        if vers:
            major = max(vers, key=lambda v: tuple(int(x) for x in v.split("."))).split(".")[0]
    except OSError:
        pass
    if major is None and os.name != "nt":
        try:
            m = re.search(r"(\d+)\.\d+", subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=5).stdout)
            major = m.group(1) if m else None
        except Exception:
            major = None
    if not major:
        return None
    system = ("Windows NT 10.0; Win64; x64" if sys.platform == "win32" else
              "Macintosh; Intel Mac OS X 10_15_7" if sys.platform == "darwin" else "X11; Linux x86_64")
    return f"Mozilla/5.0 ({system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"


def normal_identity(info: dict) -> dict:
    """What normal Chrome on this PC says about itself: for Emulation.setUserAgentOverride."""
    ua = (info.get("User-Agent") or "").replace("HeadlessChrome", "Chrome")
    full = (info.get("Browser") or "Chrome/0").split("/")[-1]
    major = full.split(".")[0]
    platform, nav = (("Windows", "Win32") if sys.platform == "win32" else
                     ("macOS", "MacIntel") if sys.platform == "darwin" else ("Linux", "Linux x86_64"))
    brands = [("Google Chrome", major, full), ("Chromium", major, full), ("Not_A Brand", "24", "24.0.0.0")]
    return {
        "userAgent": ua,
        "acceptLanguage": "en-US,en;q=0.9",
        "platform": nav,
        "userAgentMetadata": {
            "brands": [{"brand": b, "version": v} for b, v, _ in brands],
            "fullVersionList": [{"brand": b, "version": f} for b, _, f in brands],
            "fullVersion": full, "platform": platform,
            "platformVersion": "15.0.0" if platform == "Windows" else "",
            "architecture": "x86", "model": "", "mobile": False, "bitness": "64", "wow64": False,
        },
    }


class BrowserManager:
    """The one Chrome and its tabs (browser cards), started on first use."""

    def __init__(self, data_dir: str, log, profile: str = "browser-profile"):
        self.data_dir = data_dir
        self.profile_name = profile  # one Chrome per profile: a second canvas server needs its own
        self.log = log
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.port = 0
        self.tabs: dict[str, Tab] = {}
        self.identity: dict | None = None
        self.signing: subprocess.Popen | None = None  # the visible sign-in window, while it's open
        self.browser_ws: str | None = None

    @property
    def available(self) -> str | None:
        """None if browser cards can work here, else why not."""
        if ws_connect is None:
            return "browser cards need the websockets package: pip install websockets"
        if not find_chrome():
            return "browser cards need Google Chrome or Chromium on the PC"
        return None

    def _port_file(self) -> str:
        """Where the hidden Chrome's DevTools port is noted, next to its profile."""
        return os.path.join(self.data_dir, self.profile_name + ".chrome.json")

    def _close_leftover(self) -> None:
        """A canvas server that was stopped (a restart kills it) leaves its hidden Chrome running,
        and that Chrome keeps the profile, so a new one can't start and browser cards hang. Close
        it through the DevTools port this profile's Chrome last ran on."""
        try:
            with open(self._port_file(), encoding="utf-8") as f:
                port = int(json.load(f)["port"])
        except (OSError, ValueError, KeyError, TypeError):
            return
        version = f"http://127.0.0.1:{port}/json/version"
        try:
            info = json.loads(urllib.request.urlopen(version, timeout=1).read())
        except Exception:
            return  # gone already
        try:
            with ws_connect(info["webSocketDebuggerUrl"], max_size=4 * 1024 * 1024, open_timeout=3) as ws:
                ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
                ws.recv(timeout=3)
        except Exception:
            pass
        for _ in range(50):
            try:
                urllib.request.urlopen(version, timeout=0.5)
                time.sleep(0.1)
            except Exception:
                break
        time.sleep(0.5)  # it lets go of the profile as it exits
        self.log(f"browser: closed a hidden Chrome left from an earlier run (port {port})")

    def _chrome(self) -> None:
        if self.proc and self.proc.poll() is None:
            return
        self._close_leftover()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        profile = os.path.join(self.data_dir, self.profile_name)
        os.makedirs(profile, exist_ok=True)
        args = [find_chrome(), "--headless=new", f"--remote-debugging-port={self.port}",
                "--remote-debugging-address=127.0.0.1", f"--user-data-dir={profile}", "--no-first-run",
                "--no-default-browser-check", f"--window-size={VIEW_W},{VIEW_H}", "--hide-scrollbars",
                "--disable-features=Translate", "--disable-blink-features=AutomationControlled",
                "--lang=en-US", "about:blank"]
        ua = chrome_user_agent()
        if ua:  # normal Chrome from the very first request, new tabs included
            args.insert(1, f"--user-agent={ua}")
        flags = 0x08000000 if os.name == "nt" else 0  # no window
        self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, creationflags=flags)
        for _ in range(100):
            try:
                info = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/version", timeout=1).read())
                self.identity = normal_identity(info)
                self.browser_ws = info.get("webSocketDebuggerUrl")
                try:  # so the next server can close this Chrome if this one is killed
                    with open(self._port_file(), "w", encoding="utf-8") as f:
                        json.dump({"port": self.port, "pid": self.proc.pid}, f)
                except OSError:
                    pass
                self.log(f"browser: Chrome up (pid {self.proc.pid})")
                threading.Thread(target=self._watch, args=(info.get("webSocketDebuggerUrl"), self.proc),
                                 daemon=True, name="browser-targets").start()
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("Chrome didn't start")

    def open(self, url: str, bid: str | None = None) -> Tab:
        why = self.available
        if why:
            raise RuntimeError(why)
        with self.lock:
            if self.signing and self.signing.poll() is None:
                raise RuntimeError("signing in on the PC: close that Chrome window when you're done")
            self._chrome()
            bid = bid or "br-" + secrets.token_hex(4)
            old = self.tabs.pop(bid, None)
            if old:  # its Chrome tab too, not just our connection to it (or it stays open for good)
                old.close()
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/close/{old.target}", timeout=5).read()
                except Exception:
                    pass
            # a blank tab first (it's made normal Chrome before the page's first request), in its own
            # window: tabs sharing a window would hide each other (no input, no new pictures)
            target = self._new_window()
            tab = Tab(bid, target, self.log, self.identity, normalize_url(url))
            self.tabs[bid] = tab
            self.log(f"browser: {bid} -> {url}")
            return tab

    def _new_window(self) -> dict:
        ws = ws_connect(self.browser_ws, max_size=4 * 1024 * 1024, open_timeout=10)
        try:
            ws.send(json.dumps({"id": 1, "method": "Target.createTarget",
                                "params": {"url": "about:blank", "newWindow": True}}))
            while True:
                msg = json.loads(ws.recv(timeout=10))
                if msg.get("id") == 1:
                    if "error" in msg:
                        raise RuntimeError(msg["error"].get("message", "can't open a tab"))
                    tid = msg["result"]["targetId"]
                    return {"id": tid, "url": "about:blank", "title": "",
                            "webSocketDebuggerUrl": f"ws://127.0.0.1:{self.port}/devtools/page/{tid}"}
        finally:
            ws.close()

    # ---- new tabs and popups opened by the pages themselves
    def _watch(self, url: str | None, proc) -> None:
        """Chrome's own connection: tells us when a page opens a new tab or closes one."""
        if not url:
            return
        try:
            ws = ws_connect(url, max_size=16 * 1024 * 1024, open_timeout=10)
            ws.send(json.dumps({"id": 1, "method": "Target.setDiscoverTargets", "params": {"discover": True}}))
            started = False  # the tabs reported before the answer already existed (Chrome's start page)
            for raw in ws:
                msg = json.loads(raw)
                method = msg.get("method")
                if msg.get("id") == 1:
                    started = True
                elif method == "Target.targetCreated" and started:
                    info = msg["params"]["targetInfo"]
                    if info.get("type") == "page":
                        threading.Thread(target=self._new_target, args=(info, proc), daemon=True).start()
        except Exception:
            pass  # Chrome stopped; the next one gets its own watcher

    def _new_target(self, info: dict, proc) -> None:
        """A page opened a tab anyway (a popup the in-page script didn't catch): load it in the
        card that opened it instead, and close the extra tab."""
        time.sleep(1.0)  # our own new tabs register within this
        tid = info["targetId"]
        with self.lock:
            if self.proc is not proc or any(t.target == tid for t in self.tabs.values()):
                return
            opener = next((t for t in self.tabs.values() if info.get("openerId") and t.target == info["openerId"]), None)
            if opener is None:  # rel=noopener tabs don't say who opened them: the card just tapped did
                now = time.monotonic()
                recent = [t for t in self.tabs.values() if now - t.last_input < 5]
                opener = max(recent, key=lambda t: t.last_input) if recent else None
            port = self.port
        if opener is None:
            return  # Chrome's own start page, not a card's
        url = ""
        for _ in range(20):  # its address, once it has one
            try:
                listing = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3).read())
                url = next((t.get("url") or "" for t in listing if t.get("id") == tid), "")
            except Exception:
                url = ""
            if url and url != "about:blank":
                break
            time.sleep(0.25)
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/json/close/{tid}", timeout=5).read()
        except Exception:
            pass
        if url and url != "about:blank":
            self.log(f"browser: {opener.id} opened {url} in the same card")
            opener.call("Page.navigate", url=url)

    def get(self, bid: str) -> Tab | None:
        tab = self.tabs.get(bid)
        return tab if tab and tab.alive else None

    def sign_in(self, url: str) -> None:
        """Pause the hidden Chrome and open a normal Chrome window on this PC with the cards'
        profile, for sites that won't let a hidden browser sign in. When that window is closed,
        the cards reopen (signed in) the next time they ask for a picture."""
        why = self.available
        if why:
            raise RuntimeError(why)
        with self.lock:
            if self.signing and self.signing.poll() is None:
                return  # already open
            for tab in self.tabs.values():
                tab.close()
            self.tabs.clear()
            if self.proc and self.proc.poll() is None:  # the profile can only be open once
                self.proc.terminate()
                try:
                    self.proc.wait(10)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
            self.proc = None
            self._close_leftover()
            profile = os.path.join(self.data_dir, self.profile_name)
            os.makedirs(profile, exist_ok=True)
            self.signing = subprocess.Popen(
                [find_chrome(), f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
                 "--new-window", normalize_url(url)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.log(f"browser: sign-in window open on the PC ({url}); cards pause until it's closed")
            proc = self.signing

        def watch():
            proc.wait()
            self.log("browser: sign-in window closed; cards resume")
        threading.Thread(target=watch, daemon=True, name="browser-signin").start()

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
