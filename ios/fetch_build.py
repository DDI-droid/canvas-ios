"""Fetch the latest iPad app build from GitHub Actions into canvas/data/app/.

The canvas server then offers it at /app/Canvas.ipa, with a SideStore source at
/app/source.json (both need the ?k= key). In SideStore the app shows an update.

    python canvas/ios/fetch_build.py            # latest successful build
    python canvas/ios/fetch_build.py --run 12   # a specific run number

Uses the GitHub CLI: `gh` on PATH, or tools/gh/bin/gh.exe in the training folder.
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

HERE = os.path.dirname(os.path.abspath(__file__))
CANVAS = os.path.dirname(HERE)
APP_DIR = os.path.join(CANVAS, "data", "app")
WORKFLOW = "build.yml"


def gh_exe() -> str:
    local = os.path.join(os.path.dirname(CANVAS), "tools", "gh", "bin", "gh.exe")
    return shutil.which("gh") or local


def gh(*args: str) -> str:
    res = subprocess.run([gh_exe(), *args], cwd=CANVAS, capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        sys.exit(f"gh {' '.join(args)} failed:\n{res.stderr.strip()}")
    return res.stdout


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--run", type=int, help="run number (default: latest successful)")
    ap.add_argument("--no-publish", action="store_true", help="don't publish to the SideStore source gist")
    args = ap.parse_args()

    runs = json.loads(gh("run", "list", "--workflow", WORKFLOW, "--limit", "30",
                         "--json", "databaseId,number,status,conclusion,headSha,createdAt,displayTitle"))
    ok = [r for r in runs if r["conclusion"] == "success" and (args.run is None or r["number"] == args.run)]
    if not ok:
        sys.exit("no successful build found" + (f" for run {args.run}" if args.run else ""))
    run = ok[0]

    with tempfile.TemporaryDirectory() as tmp:
        gh("run", "download", str(run["databaseId"]), "--name", "Canvas-ipa", "--dir", tmp)
        src = os.path.join(tmp, "Canvas.ipa")
        if not os.path.isfile(src):
            sys.exit("the build artifact has no Canvas.ipa")
        # a failed build can still produce an IPA with an empty app (builds 5 and 6 did, while
        # CI ignored the failure): never copy or publish one without the app's program in it
        import zipfile
        with zipfile.ZipFile(src) as z:
            names = set(z.namelist())
        if not {"Payload/Canvas.app/Canvas", "Payload/Canvas.app/Info.plist"} <= names:
            sys.exit(f"build {run['number']} is broken (its IPA has no app inside): not copied or published")
        os.makedirs(APP_DIR, exist_ok=True)
        shutil.copyfile(src, os.path.join(APP_DIR, "Canvas.ipa.tmp"))
        os.replace(os.path.join(APP_DIR, "Canvas.ipa.tmp"), os.path.join(APP_DIR, "Canvas.ipa"))

    version = "1.0"
    try:
        with open(os.path.join(HERE, "project.yml"), "r", encoding="utf-8") as f:
            m = re.search(r'MARKETING_VERSION:\s*"?([0-9.]+)', f.read())
        version = m.group(1) if m else version
    except OSError:
        pass
    info = {"version": version, "build": run["number"], "commit": run["headSha"][:7],
            "notes": run["displayTitle"], "built": run["createdAt"]}
    with open(os.path.join(APP_DIR, "build.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=1)
    size = os.path.getsize(os.path.join(APP_DIR, "Canvas.ipa"))
    print(f"build {run['number']} ({info['commit']}): {size / 1e6:.1f} MB -> data/app/Canvas.ipa")
    if not args.no_publish:
        # the SideStore source whose address never changes (publish_app.py)
        sys.path.insert(0, HERE)
        import publish_app
        publish_app.publish()


if __name__ == "__main__":
    main()
