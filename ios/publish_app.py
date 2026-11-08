"""Publish the iPad app to a SideStore source whose address never changes.

The canvas server's own /app/source.json lives at the tunnel's address, which changes whenever
the tunnel restarts; SideStore keeps a source's address fixed, so updates would stop arriving.
This puts the app in a secret GitHub gist instead (unlisted; nothing in it is secret: the app,
its icon and the listing, no key):

    https://gist.githubusercontent.com/<you>/<gist>/raw/source.json      <- add this to SideStore once

Each publish pins the download to that exact upload (a revision URL), so SideStore never gets a
stale copy. fetch_build.py runs this after every download.

    python canvas/ios/publish_app.py           # publish data/app/Canvas.ipa + build.json
    python canvas/ios/publish_app.py --url     # print the source address
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CANVAS = os.path.dirname(HERE)
APP_DIR = os.path.join(CANVAS, "data", "app")
GIST_INFO = os.path.join(APP_DIR, "gist.json")
ICON = os.path.join(CANVAS, "static", "icon-512.png")


def gh_exe() -> str:
    local = os.path.join(os.path.dirname(CANVAS), "tools", "gh", "bin", "gh.exe")
    return shutil.which("gh") or local


def run(cmd: list[str], cwd: str | None = None, stdin: str | None = None) -> str:
    r = subprocess.run(cmd, cwd=cwd, input=stdin, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.exit(f"{' '.join(cmd[:3])}… failed:\n{(r.stderr or r.stdout).strip()}")
    return r.stdout.strip()


def git(*args: str, cwd: str) -> str:
    # authenticate through the GitHub CLI's login; never touch line endings (the IPA is binary)
    helper = f"!'{gh_exe().replace(os.sep, '/')}' auth git-credential"
    return run(["git", "-c", "credential.helper=", "-c", f"credential.helper={helper}",
                "-c", "core.autocrlf=false", *args], cwd=cwd)


def gist_info() -> dict:
    try:
        with open(GIST_INFO, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def source_url(info: dict) -> str:
    return f"https://gist.githubusercontent.com/{info['owner']}/{info['id']}/raw/source.json"


def ensure_gist() -> dict:
    info = gist_info()
    if info.get("id") and info.get("owner"):
        return info
    owner = run([gh_exe(), "api", "user", "--jq", ".login"])
    out = run([gh_exe(), "gist", "create", "--filename", "source.json",
               "--desc", "Canvas iPad app: SideStore source (no secrets)", "-"], stdin='{"name": "Canvas", "apps": []}')
    m = re.search(r"([0-9a-f]{20,64})\s*$", out)
    if not m:
        sys.exit(f"unexpected gh output: {out}")
    info = {"id": m.group(1), "owner": owner}
    os.makedirs(APP_DIR, exist_ok=True)
    with open(GIST_INFO, "w", encoding="utf-8") as f:
        json.dump(info, f, indent=1)
    return info


def listing(build: dict, size: int, ipa_url: str, icon_url: str) -> dict:
    return {
        "name": "Canvas",
        "identifier": "com.canvasboard.source",
        "apps": [{
            "name": "Canvas",
            "bundleIdentifier": "com.canvasboard.canvas",
            "developerName": "Claude",
            "subtitle": "Pencil canvas + voice for Claude Code",
            "localizedDescription": "Your canvas as an iPad app: Apple Pencil, Apple's own speech recognition, "
                                    "and every installed voice, including Premium ones.",
            "iconURL": icon_url,
            "tintColor": "D2693F",
            "versions": [{
                "version": str(build.get("version") or "1.0"),
                "buildVersion": str(build.get("build") or 1),
                "date": build.get("built") or datetime.now().astimezone().isoformat(timespec="seconds"),
                "localizedDescription": str(build.get("notes") or "Latest build."),
                "downloadURL": ipa_url,
                "size": size,
                "minOSVersion": "17.0",
            }],
            "appPermissions": {"entitlements": [], "privacy": {
                "NSMicrophoneUsageDescription": "Canvas listens while you talk, so Claude can hear what you say.",
                "NSSpeechRecognitionUsageDescription": "Canvas turns what you say into text for Claude.",
            }},
        }],
        "news": [],
    }


def publish() -> str:
    ipa = os.path.join(APP_DIR, "Canvas.ipa")
    if not os.path.isfile(ipa):
        sys.exit("no data/app/Canvas.ipa yet: run fetch_build.py first")
    try:
        with open(os.path.join(APP_DIR, "build.json"), encoding="utf-8") as f:
            build = json.load(f)
    except (OSError, ValueError):
        build = {}
    info = ensure_gist()
    raw = f"https://gist.githubusercontent.com/{info['owner']}/{info['id']}/raw"
    with tempfile.TemporaryDirectory() as tmp:
        repo = os.path.join(tmp, "gist")
        git("clone", "--quiet", f"https://gist.github.com/{info['id']}.git", repo, cwd=tmp)
        git("config", "user.name", info["owner"], cwd=repo)
        git("config", "user.email", f"{info['owner']}@users.noreply.github.com", cwd=repo)
        # 1) the app and its icon, so the listing can point at this exact revision
        shutil.copyfile(ipa, os.path.join(repo, "Canvas.ipa"))
        shutil.copyfile(ICON, os.path.join(repo, "icon.png"))
        git("add", "Canvas.ipa", "icon.png", cwd=repo)
        if git("status", "--porcelain", cwd=repo):
            git("commit", "--quiet", "-m", f"Canvas {build.get('version')} (build {build.get('build')})", cwd=repo)
        sha = git("rev-parse", "HEAD", cwd=repo)
        # 2) the listing
        src = listing(build, os.path.getsize(ipa), f"{raw}/{sha}/Canvas.ipa", f"{raw}/{sha}/icon.png")
        with open(os.path.join(repo, "source.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(src, f, indent=1)
        git("add", "source.json", cwd=repo)
        if git("status", "--porcelain", cwd=repo):
            git("commit", "--quiet", "-m", "listing", cwd=repo)
        git("push", "--quiet", "origin", "HEAD", cwd=repo)
    url = source_url(info)
    print(f"published Canvas {build.get('version')} (build {build.get('build')}) -> {url}")
    return url


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", action="store_true", help="print the source address and exit")
    a = ap.parse_args()
    if a.url:
        info = gist_info()
        print(source_url(info) if info.get("id") else "not published yet")
        return
    publish()


if __name__ == "__main__":
    main()
