#!/usr/bin/env python3
"""Set Claude's status pill on the canvas page.

  python canvas/status.py thinking
  python canvas/status.py idle
  python canvas/status.py "Reading your derivation..."
"""
from __future__ import annotations

import argparse

from _client import call, die, setup_utf8


def main() -> None:
    setup_utf8()
    ap = argparse.ArgumentParser(description="Set the canvas status pill")
    ap.add_argument("status", nargs="+", help="thinking | idle | any short custom text")
    ap.add_argument("--port", type=int, help="server port (default: from data/server.json or 8765)")
    args = ap.parse_args()
    status = " ".join(args.status).strip()
    if not status:
        die("status is empty")
    res = call("POST", "/api/status", {"status": status}, port=args.port)
    print(f"status set: {res.get('status', {}).get('status', status)}")


if __name__ == "__main__":
    main()
