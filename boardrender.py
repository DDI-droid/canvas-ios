"""The PC's own pictures of a board: the change map and "show me this rectangle".

The voice and the main agent get pictures of the board drawn here, on the PC, from what the PC
stores (strokes, drawings, cards), instead of asking the iPad for them: the iPad may be asleep,
and the user wants it to do as little as possible. A headless Chrome on this PC keeps one tab on
static/render.html, which draws with the iPad's own stroke code (render.js). A picture takes a
few hundred ms once Chrome is up; Chrome starts with the first picture (2-3 s) and quits after
two minutes with nothing to draw. Its own throwaway profile: data/boardrender-profile.
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

try:
    from websockets.sync.client import connect as ws_connect
except Exception:  # pragma: no cover
    ws_connect = None

from browser import find_chrome

IDLE_S = 120


def end_orphans(profile: str, log=None) -> None:
    """End any Chrome still running on `profile`: one left by a server that was stopped (its
    Chrome outlives it and keeps the profile, so a new one can't start on it)."""
    try:
        import psutil
    except ImportError:
        return
    want = os.path.normcase(os.path.abspath(profile))
    for p in psutil.process_iter(["name", "cmdline"]):
        try:
            if "chrome" not in (p.info["name"] or "").lower():
                continue
            for arg in p.info["cmdline"] or []:
                if arg.startswith("--user-data-dir=") and os.path.normcase(os.path.abspath(arg.split("=", 1)[1])) == want:
                    if log:
                        log(f"ending a leftover Chrome on {os.path.basename(profile)} (pid {p.pid})")
                    p.kill()
                    break
        except Exception:
            continue


class BoardRenderer:
    def __init__(self, data_dir: str, page_url, build, log):
        """page_url(): the render page's URL on this PC, with the key. build(): the code's version
        now (the tab reloads when it changes)."""
        self.profile = os.path.join(data_dir, "boardrender-profile")
        self.page_url = page_url
        self.build = build
        self.log = log
        self.lock = threading.Lock()   # one picture at a time
        self.proc: subprocess.Popen | None = None
        self.port: int | None = None
        self.ws = None
        self.tab_build = None
        self.seq = 0
        self.last_used = 0.0
        self._reaper: threading.Thread | None = None

    # ---- the one call
    def render(self, spec: dict, timeout: float = 25.0) -> dict:
        """Draw `spec` (see render.js: board, rev, tiles, since, ...). Returns {png: bytes, width,
        height, tiles}. Raises on failure."""
        if ws_connect is None:
            raise RuntimeError("the websockets package is missing")
        with self.lock:
            self.last_used = time.monotonic()
            for attempt in (1, 2):
                try:
                    self._ensure_tab()
                    expr = f"window.canvasRender({json.dumps(spec)})"
                    res = self._call("Runtime.evaluate", timeout, expression=expr, awaitPromise=True,
                                     returnByValue=True)
                    r = res.get("result") or {}
                    if r.get("exceptionDetails"):
                        d = r["exceptionDetails"]
                        raise RuntimeError(((d.get("exception") or {}).get("description") or d.get("text") or "error")[:300])
                    v = (r.get("result") or {}).get("value") or {}
                    url = v.get("dataUrl") or ""
                    if not url.startswith("data:image/png;base64,"):
                        raise RuntimeError("no picture came back")
                    self.last_used = time.monotonic()
                    self._start_reaper()
                    return {"png": base64.b64decode(url.split(",", 1)[1]), "width": v.get("width"),
                            "height": v.get("height"), "tiles": v.get("tiles") or []}
                except Exception as e:
                    self.log(f"board picture failed (try {attempt}): {e}")
                    self._stop()
                    if attempt == 2:
                        raise

    def warm(self) -> None:
        """Start Chrome and load the render page now, so the next picture is quick."""
        if ws_connect is None:
            return
        try:
            with self.lock:
                self.last_used = time.monotonic()
                self._ensure_tab()
            self._start_reaper()
        except Exception as e:
            self.log(f"board pictures: warm-up failed: {e}")
            with self.lock:
                self._stop()

    # ---- Chrome and its tab
    def _ensure_tab(self) -> None:
        build = self.build()
        if self.ws is not None and self.proc and self.proc.poll() is None and self.tab_build == build:
            return
        if self.ws is None or not (self.proc and self.proc.poll() is None):
            self._stop()
            port = self._chrome()
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10) as r:
                pages = [t for t in json.loads(r.read()) if t.get("type") == "page"]
            if not pages:
                req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?about:blank", method="PUT")
                with urllib.request.urlopen(req, timeout=10) as r:
                    pages = [json.loads(r.read())]
            self.ws = ws_connect(pages[0]["webSocketDebuggerUrl"], max_size=256 * 1024 * 1024, open_timeout=10)
            self._call("Page.enable", 10)
        # (re)load the render page: first time, or the code changed
        self._call("Page.navigate", 15, url=self.page_url())
        end = time.time() + 20
        while time.time() < end:
            res = self._call("Runtime.evaluate", 5, expression="!!window.canvasRenderReady", returnByValue=True)
            if ((res.get("result") or {}).get("result") or {}).get("value"):
                self.tab_build = build
                return
            time.sleep(0.1)
        raise RuntimeError("the render page didn't load")

    def _call(self, method: str, timeout: float, **params) -> dict:
        self.seq += 1
        n = self.seq
        self.ws.send(json.dumps({"id": n, "method": method, "params": params}))
        end = time.time() + timeout
        while True:
            left = end - time.time()
            if left <= 0:
                raise TimeoutError(f"{method} took over {timeout:.0f} s")
            msg = json.loads(self.ws.recv(timeout=left))
            if msg.get("id") == n:
                if msg.get("error"):
                    raise RuntimeError(f"{method}: {msg['error'].get('message')}")
                return msg

    def _chrome(self) -> int:
        exe = find_chrome()
        if not exe:
            raise RuntimeError("Chrome isn't installed")
        os.makedirs(self.profile, exist_ok=True)
        end_orphans(self.profile, self.log)
        port_file = os.path.join(self.profile, "DevToolsActivePort")
        try:
            os.remove(port_file)
        except OSError:
            pass
        flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
        self.proc = subprocess.Popen(
            [exe, "--headless=new", "--hide-scrollbars", "--mute-audio", "--no-first-run",
             "--no-default-browser-check", "--remote-debugging-port=0", f"--user-data-dir={self.profile}",
             "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, creationflags=flags)
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                with open(port_file, "r", encoding="utf-8") as f:
                    self.port = int(f.read().split()[0])
                return self.port
            except (OSError, ValueError, IndexError):
                if self.proc.poll() is not None:
                    break
                time.sleep(0.1)
        raise RuntimeError("Chrome didn't start")

    def _stop(self) -> None:
        ws, self.ws, self.tab_build = self.ws, None, None
        try:
            if ws is not None:
                ws.close()
        except Exception:
            pass
        proc, self.proc, self.port = self.proc, None, None
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def _start_reaper(self) -> None:
        if self._reaper and self._reaper.is_alive():
            return

        def reap():
            while True:
                time.sleep(15)
                with self.lock:
                    if self.proc is None:
                        return
                    if time.monotonic() - self.last_used > IDLE_S:
                        self._stop()
                        return

        self._reaper = threading.Thread(target=reap, name="boardrender-idle", daemon=True)
        self._reaper.start()
