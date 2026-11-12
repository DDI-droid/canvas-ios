"""Pictures of live pages, for the board pictures sent to Claude and the voice.

A live page (an agent's HTML, a chart, a 3D model) runs in a sandboxed frame on the canvas, so the
canvas page can't draw what it shows into a board picture: it came out as a blank card. Instead,
the server loads the page in a headless Chrome on this PC, at the card's size, and keeps a PNG of
it next to the page (pages/<token>.png), served at /live/<token>/shot.png. A picture is made when
it's first asked for, and again when the page, its data or the card's size changes; until then
the previous one (or none) is served, so nobody waits on Chrome.

One Chrome (its own throwaway profile, data/pageshot-profile) starts when a picture is needed and
quits after a minute and a half with nothing to do. Separate from the browser cards' Chrome
(browser.py), which keeps the user's sign-ins.
"""
from __future__ import annotations

import base64
import json
import os
import struct
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

IDLE_S = 90          # Chrome quits after this long with no picture to make
SETTLE_S = 1.2       # after the page loads: charts animate in, fonts and images settle
MAX_SIDE = 2400


def png_size(path: str) -> tuple[int, int] | None:
    """(width, height) from a PNG's header, or None."""
    try:
        with open(path, "rb") as f:
            head = f.read(24)
        if head[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        return struct.unpack(">II", head[16:24])
    except OSError:
        return None


class PageShots:
    def __init__(self, data_dir: str, log):
        self.profile = os.path.join(data_dir, "pageshot-profile")
        self.log = log
        self.cv = threading.Condition()
        self.pending: dict[str, tuple[str, int, int]] = {}   # out path -> (url, width, height)
        self.thread: threading.Thread | None = None
        self.proc: subprocess.Popen | None = None
        self.port: int | None = None
        self.current: tuple | None = None                     # (out, url, w, h) being made now

    def request(self, url: str, out: str, width: int, height: int) -> None:
        """Make (or remake) the picture at `out`. Returns at once; asking again before it's made
        just updates the size."""
        if ws_connect is None:
            return
        w = max(64, min(int(width), MAX_SIDE))
        h = max(64, min(int(height), MAX_SIDE))
        with self.cv:
            if self.current == (out, url, w, h):
                return  # being made right now
            self.pending[out] = (url, w, h)
            if self.thread is None:
                self.thread = threading.Thread(target=self._run, name="pageshots", daemon=True)
                self.thread.start()
            self.cv.notify()

    def _run(self) -> None:
        while True:
            with self.cv:
                if not self.pending:
                    self.cv.wait(timeout=IDLE_S)
                if not self.pending:
                    self.thread = None
                    self._stop_chrome()
                    return
                out, (url, w, h) = self.pending.popitem()
                self.current = (out, url, w, h)
            try:
                t0 = time.perf_counter()
                self._shoot(url, out, w, h)
                self.log(f"page picture {os.path.basename(out)} {w}x{h} in {time.perf_counter() - t0:.1f} s")
            except Exception as e:  # a bad page or a stuck Chrome: start fresh next time
                self.log(f"page picture {os.path.basename(out)} failed: {e}")
                self._stop_chrome()
            finally:
                with self.cv:
                    self.current = None

    # ---- Chrome
    def _chrome(self) -> int:
        if self.proc and self.proc.poll() is None and self.port:
            return self.port
        self._stop_chrome()
        exe = find_chrome()
        if not exe:
            raise RuntimeError("Chrome isn't installed")
        os.makedirs(self.profile, exist_ok=True)
        from boardrender import end_orphans
        end_orphans(self.profile, self.log)  # one a stopped server left running on this profile
        port_file = os.path.join(self.profile, "DevToolsActivePort")
        try:
            os.remove(port_file)
        except OSError:
            pass
        flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
        self.proc = subprocess.Popen(
            [exe, "--headless=new", "--hide-scrollbars", "--mute-audio", "--no-first-run",
             "--no-default-browser-check", "--enable-unsafe-swiftshader", "--remote-debugging-port=0",
             f"--user-data-dir={self.profile}", "about:blank"],
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
        self._stop_chrome()
        raise RuntimeError("Chrome didn't start")

    def _stop_chrome(self) -> None:
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

    # ---- one picture
    def _shoot(self, url: str, out: str, w: int, h: int) -> None:
        port = self._chrome()
        req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?about:blank", method="PUT")
        with urllib.request.urlopen(req, timeout=10) as r:
            tab = json.loads(r.read())
        try:
            with ws_connect(tab["webSocketDebuggerUrl"], max_size=128 * 1024 * 1024, open_timeout=10) as ws:
                seq = 0

                def call(method: str, **params) -> int:
                    nonlocal seq
                    seq += 1
                    ws.send(json.dumps({"id": seq, "method": method, "params": params}))
                    return seq

                def wait_for(match, timeout: float):
                    end = time.time() + timeout
                    while True:
                        left = end - time.time()
                        if left <= 0:
                            return None
                        try:
                            msg = json.loads(ws.recv(timeout=left))
                        except TimeoutError:
                            return None
                        if match(msg):
                            return msg

                def done(n: int, timeout: float = 10):
                    return wait_for(lambda m: m.get("id") == n, timeout)

                done(call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=False))
                done(call("Page.enable"))
                call("Page.navigate", url=url)
                wait_for(lambda m: m.get("method") == "Page.loadEventFired", 20)
                time.sleep(SETTLE_S)
                m = done(call("Page.captureScreenshot", format="png"), 20)
                data = ((m or {}).get("result") or {}).get("data")
                if not data:
                    raise RuntimeError("Chrome returned no picture")
            tmp = out + ".tmp"
            with open(tmp, "wb") as f:
                f.write(base64.b64decode(data))
            os.replace(tmp, out)
        finally:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/json/close/{tab['id']}", timeout=5).read()
            except Exception:
                pass
