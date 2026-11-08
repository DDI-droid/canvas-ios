#!/usr/bin/env python3
"""Keep the canvas reachable from the iPad, whatever happens on the PC.

  python canvas/supervisor.py                 run it (Ctrl+C stops); `pythonw` runs it windowless
  python canvas/supervisor.py --status        is it running, and at which address?
  python canvas/supervisor.py --stop          stop a running supervisor (and its server + tunnel)
  python canvas/supervisor.py --install-startup | --remove-startup    start it at Windows login

It runs the canvas server and a free Cloudflare "quick tunnel", and restarts either one when it
exits or stops answering. A quick tunnel gets a new random address every time it starts, so each
new address is published to a secret GitHub gist (the address only, never the key). The page
and the iPad app know where that gist is; when the old address stops answering they read it and
move to the new one by themselves. Nobody pastes links any more.

  - One instance only: a lock on 127.0.0.1:<lock port>, which also takes `stop` commands.
  - Server: restarted if it exits or stops answering /api/ping locally.
  - Tunnel: restarted if it exits, or if its public address stops answering for ~90 s while the
    server itself is fine (Cloudflare can drop a quick tunnel on its own).
  - data/link.json {"gist", "url", "updated"}: the server reads it and tells pages where the
    gist is. Logs: data/supervisor.log, data/server.log, data/tunnel.log.

Standard library only. GitHub goes through the `gh` CLI (on PATH, or tools/gh/bin/gh.exe),
which must be logged in with the `gist` scope.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

CANVAS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(CANVAS)
DATA = os.environ.get("CANVAS_DATA") or os.path.join(CANVAS, "data")  # same rule as server.py
LINK_FILE = os.path.join(DATA, "link.json")
GIST_FILE = "canvas-link.json"
TUNNEL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW: children stay invisible
CHECK_EVERY = 15        # s between health checks
SERVER_MISSES = 3       # local pings in a row before the server is restarted
TUNNEL_MISSES = 6       # public pings in a row (~90 s) before the tunnel is replaced


# --------------------------------------------------------------------------- small helpers
def now_ms() -> int:
    return int(time.time() * 1000)


def find_tool(name: str, *fallbacks: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for f in fallbacks:
        if os.path.isfile(f):
            return f
    return None


def read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path: str, obj: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


class Log:
    def __init__(self, path: str, limit: int = 2_000_000):
        self.path, self.limit, self.lock = path, limit, threading.Lock()

    def __call__(self, msg: str) -> None:
        line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}\n"
        with self.lock:
            try:
                if os.path.exists(self.path) and os.path.getsize(self.path) > self.limit:
                    os.replace(self.path, self.path + ".1")
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line)
            except OSError:
                pass
        if sys.stdout is not None:  # pythonw has no console
            try:
                print(line, end="", flush=True)
            except Exception:
                pass


def ping(url: str, key: str, timeout: float = 8.0) -> bool:
    """True if the canvas server answered (any HTTP status below 500 counts as alive)."""
    req = urllib.request.Request(url + "/api/ping", headers={"X-Canvas-Key": key, "User-Agent": "canvas-supervisor"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status < 500
    except urllib.error.HTTPError as e:
        return e.code < 500
    except Exception:
        return False


# --------------------------------------------------------------------------- the gist
class Gist:
    """The secret gist that says where the canvas is now. Holds the address only."""

    def __init__(self, gh: str | None, log: Log, link_file: str):
        self.gh, self.log, self.link_file = gh, log, link_file

    def _run(self, args: list[str], stdin: str | None = None) -> str:
        r = subprocess.run([self.gh, *args], input=stdin, capture_output=True, text=True,
                           encoding="utf-8", timeout=60, creationflags=NO_WINDOW)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip()[:300])
        return r.stdout

    def publish(self, url: str) -> bool:
        if not self.gh:
            self.log("gh (GitHub CLI) not found: the address isn't published; the app can't follow it")
            return False
        info = read_json(self.link_file)
        content = json.dumps({"url": url, "updated": now_ms(), "app": "canvas"})
        try:
            gid = info.get("gist")
            if gid:
                body = json.dumps({"files": {GIST_FILE: {"content": content}}})
                self._run(["api", "--method", "PATCH", f"gists/{gid}", "--input", "-"], stdin=body)
            else:
                out = self._run(["gist", "create", "--filename", GIST_FILE,
                                 "--desc", "Canvas: where the canvas server is now (address only, no key)", "-"],
                                stdin=content)
                m = re.search(r"https://gist\.github\.com/(?:[\w-]+/)?([0-9a-f]+)", out)
                if not m:
                    raise RuntimeError(f"unexpected gh output: {out.strip()[:200]}")
                gid = m.group(1)
                self.log(f"created the secret gist {gid}")
            write_json(self.link_file, {"gist": gid, "url": url, "updated": now_ms()})
            self.log(f"published {url}")
            return True
        except Exception as e:
            self.log(f"couldn't publish the address ({e}); will retry")
            return False


# --------------------------------------------------------------------------- a supervised child
class Child:
    def __init__(self, name: str, cmd: list[str], log: Log, out_path: str, on_line=None):
        self.name, self.cmd, self.log, self.out_path, self.on_line = name, cmd, log, out_path, on_line
        self.proc: subprocess.Popen | None = None
        self.backoff = 1.0
        self.started = 0.0

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> None:
        self.started = time.time()
        out = open(self.out_path, "a", encoding="utf-8", errors="replace")
        out.write(f"\n===== {datetime.now():%Y-%m-%d %H:%M:%S} start {self.name}\n")
        out.flush()
        if self.on_line:  # read the output ourselves (the tunnel prints its address there)
            self.proc = subprocess.Popen(self.cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         stdin=subprocess.DEVNULL, creationflags=NO_WINDOW,
                                         text=True, encoding="utf-8", errors="replace")
            threading.Thread(target=self._pump, args=(self.proc, out), daemon=True).start()
        else:
            self.proc = subprocess.Popen(self.cmd, cwd=ROOT, stdout=out, stderr=subprocess.STDOUT,
                                         stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        self.log(f"started {self.name} (pid {self.proc.pid})")

    def _pump(self, proc, out) -> None:
        for line in proc.stdout:
            out.write(line)
            out.flush()
            try:
                self.on_line(line)
            except Exception:
                pass
        out.close()

    def stop(self) -> None:
        p, self.proc = self.proc, None
        if p is None or p.poll() is not None:
            return
        if os.name == "nt":  # the whole tree (the server starts the voice talker)
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True, creationflags=NO_WINDOW)
        else:
            p.terminate()
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()

    def restart(self, why: str) -> None:
        self.log(f"restarting {self.name}: {why} (in {self.backoff:.0f} s)")
        self.stop()
        time.sleep(self.backoff)
        self.backoff = min(60.0, self.backoff * 2)
        self.start()

    def settled(self) -> None:
        """It ran fine for a while: the next restart can be quick again."""
        if self.alive() and time.time() - self.started > 120:
            self.backoff = 1.0


# --------------------------------------------------------------------------- the supervisor
class Supervisor:
    def __init__(self, port: int, lock_port: int):
        os.makedirs(DATA, exist_ok=True)
        self.port, self.lock_port = port, lock_port
        self.local = f"http://127.0.0.1:{port}"
        self.log = Log(os.path.join(DATA, "supervisor.log"))
        self.link_file = LINK_FILE  # one gist, whichever port this runs on
        self.gist = Gist(find_tool("gh", os.path.join(ROOT, "tools", "gh", "bin", "gh.exe")), self.log, self.link_file)
        cloudflared = find_tool("cloudflared", os.path.join(ROOT, "tools", "cloudflared", "cloudflared.exe"))
        if not cloudflared:
            raise SystemExit("cloudflared not found (on PATH or tools/cloudflared/)")
        python = sys.executable
        if os.path.basename(python).lower() == "pythonw.exe":  # the server is fine windowless too
            python = os.path.join(os.path.dirname(python), "python.exe")
        self.server = Child("server", [python, os.path.join(CANVAS, "server.py"), "--port", str(port), "--quiet"],
                            self.log, os.path.join(DATA, "server.log" if port == 8765 else f"server-{port}.log"))
        self.tunnel = Child("tunnel", [cloudflared, "tunnel", "--no-autoupdate", "--url", self.local],
                            self.log, os.path.join(DATA, "tunnel.log" if port == 8765 else f"tunnel-{port}.log"),
                            on_line=self._tunnel_line)
        self.public: str | None = None      # the tunnel's current address
        self.published: str | None = None   # the address the gist holds
        self.stop_event = threading.Event()
        self.server_miss = self.tunnel_miss = 0

    def key(self) -> str:
        try:
            with open(os.path.join(DATA, "token.txt"), encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""

    def _tunnel_line(self, line: str) -> None:
        m = TUNNEL_RE.search(line)
        if m and m.group(0) != self.public:
            self.public = m.group(0)
            self.published = None
            self.tunnel_miss = 0
            self.log(f"tunnel address: {self.public}")

    # ---- control socket: one instance, and `--stop`
    def _listen(self, sock: socket.socket) -> None:
        sock.listen(4)
        sock.settimeout(1.0)
        while not self.stop_event.is_set():
            try:
                conn, _ = sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with conn:
                try:
                    cmd = conn.recv(64).decode("ascii", "replace").strip()
                    if cmd == "stop":
                        conn.sendall(b"stopping\n")
                        self.stop_event.set()
                    else:
                        conn.sendall((json.dumps({"public": self.public, "published": self.published}) + "\n").encode())
                except OSError:
                    pass

    def run(self) -> None:
        lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            lock.bind(("127.0.0.1", self.lock_port))
        except OSError:
            print("the canvas supervisor is already running (python canvas/supervisor.py --status)")
            return
        threading.Thread(target=self._listen, args=(lock,), daemon=True).start()
        self.log(f"supervisor up (server port {self.port})")
        if ping(self.local, self.key(), timeout=3):
            self.log(f"something already answers on port {self.port}: stop that server first")
            lock.close()
            return
        self.server.start()
        for _ in range(40):  # let the server come up before the tunnel points at it
            if ping(self.local, self.key(), timeout=2):
                break
            time.sleep(0.5)
        self.tunnel.start()
        try:
            while not self.stop_event.wait(1.0 if not self.published else CHECK_EVERY):
                self.check()
        except KeyboardInterrupt:
            pass
        finally:
            self.log("stopping")
            self.tunnel.stop()
            self.server.stop()
            lock.close()

    def check(self) -> None:
        key = self.key()
        # the server
        if not self.server.alive():
            self.server.restart("it exited")
            self.server_miss = 0
        elif ping(self.local, key):
            self.server_miss = 0
            self.server.settled()
        else:
            self.server_miss += 1
            if self.server_miss >= SERVER_MISSES:
                self.server.restart("it stopped answering")
                self.server_miss = 0
        # the tunnel
        if not self.tunnel.alive():
            self.public = None
            self.tunnel.restart("it exited")
            return
        if not self.public:
            return
        if ping(self.public, key):
            self.tunnel_miss = 0
            self.tunnel.settled()
            if self.published != self.public and self.gist.publish(self.public):
                self.published = self.public
        elif self.server_miss == 0 and self.published == self.public:
            # the server is fine but nobody can reach it: Cloudflare dropped the tunnel
            self.tunnel_miss += 1
            if self.tunnel_miss >= TUNNEL_MISSES:
                self.public = None
                self.tunnel.restart("its address stopped answering")
                self.tunnel_miss = 0


# --------------------------------------------------------------------------- commands
def control(lock_port: int, cmd: str) -> str | None:
    try:
        with socket.create_connection(("127.0.0.1", lock_port), timeout=3) as s:
            s.sendall(cmd.encode() + b"\n")
            return s.recv(4096).decode("utf-8", "replace").strip()
    except OSError:
        return None


STARTUP = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs",
                       "Startup", "Canvas supervisor.vbs")


def install_startup() -> None:
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.isfile(pythonw):
        pythonw = sys.executable
    script = os.path.abspath(__file__)
    vbs = ('\' Starts the canvas server + tunnel at login, without a window (canvas/supervisor.py).\r\n'
           f'CreateObject("WScript.Shell").Run """{pythonw}"" ""{script}""", 0, False\r\n')
    with open(STARTUP, "w", encoding="utf-8") as f:
        f.write(vbs)
    print(f"installed: {STARTUP}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8765, help="canvas server port (default 8765)")
    ap.add_argument("--lock-port", type=int, default=0, help="control port (default: port + 34)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--status", action="store_true")
    g.add_argument("--stop", action="store_true")
    g.add_argument("--install-startup", action="store_true")
    g.add_argument("--remove-startup", action="store_true")
    a = ap.parse_args()
    lock_port = a.lock_port or a.port + 34
    if a.status:
        r = control(lock_port, "status")
        info = read_json(LINK_FILE)
        print(f"running: {'yes ' + r if r else 'no'}")
        print(f"published: {info.get('url')} (gist {info.get('gist')})")
    elif a.stop:
        print(control(lock_port, "stop") or "not running")
    elif a.install_startup:
        install_startup()
    elif a.remove_startup:
        try:
            os.remove(STARTUP)
            print(f"removed: {STARTUP}")
        except OSError:
            print("wasn't installed")
    else:
        Supervisor(a.port, lock_port).run()


if __name__ == "__main__":
    main()
