#!/usr/bin/env python3
"""Inspect or erase the user's ink on the canvas (Claude-side helper).

The user's strokes live in /api/state as world-coordinate polylines
({id, tool, color, size, t0, t1, pts:[x, y, pressure, ...]}). Erasing saves the
filtered list back with PUT /api/strokes; the page reloads remote strokes on
the resulting "strokes" event.

Usage:
  python canvas/ink.py --list [--last 30]
  python canvas/ink.py --erase-ids ID [ID ...]
  python canvas/ink.py --erase-box X0 Y0 X1 Y1            # world coords
  python canvas/ink.py --erase-px X0 Y0 X1 Y1 --timeline path/to/timeline.txt
      # snapshot-pixel box from a message's snapshot.png, converted with that
      # message's pixel->world mapping
  Add --mode center to erase strokes whose bbox CENTER is in the box
  (default "inside": the whole stroke bbox must be in the box). Add --dry-run
  to preview.
"""
from __future__ import annotations

import argparse
import re
import time

from _client import call, die, setup_utf8


def bbox(stroke) -> tuple[float, float, float, float]:
    pts = stroke.get("pts") or []
    xs, ys = pts[0::3], pts[1::3]
    if not xs:
        return (0.0, 0.0, 0.0, 0.0)
    return (min(xs), min(ys), max(xs), max(ys))


def px_box_to_world(box, timeline_path: str):
    text = open(timeline_path, encoding="utf-8").read()
    m = re.search(
        r"world_x = (-?[\d.]+) \+ px_x / ([\d.]+), world_y = (-?[\d.]+) \+ px_y / ([\d.]+)",
        text,
    )
    if not m:
        die(f"no pixel->world mapping found in {timeline_path}")
    ax, sx, ay, sy = (float(g) for g in m.groups())
    x0, y0, x1, y1 = box
    return (ax + x0 / sx, ay + y0 / sy, ax + x1 / sx, ay + y1 / sy)


def selected(stroke, box, mode: str) -> bool:
    x0, y0, x1, y1 = box
    bx0, by0, bx1, by1 = bbox(stroke)
    if mode == "center":
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        return x0 <= cx <= x1 and y0 <= cy <= y1
    return x0 <= bx0 and bx1 <= x1 and y0 <= by0 and by1 <= y1


def main() -> None:
    setup_utf8()
    ap = argparse.ArgumentParser(description="Inspect or erase the user's canvas ink")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--list", action="store_true")
    g.add_argument("--erase-ids", nargs="+", metavar="ID")
    g.add_argument("--erase-box", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"))
    g.add_argument("--erase-px", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--timeline", help="timeline.txt of the message whose snapshot the px box refers to")
    ap.add_argument("--mode", choices=["inside", "center"], default="inside")
    ap.add_argument("--last", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    strokes = (call("GET", "/api/state") or {}).get("strokes") or []

    if args.list:
        now = time.time() * 1000
        for s in sorted(strokes, key=lambda s: s.get("t0", 0))[-args.last:]:
            x0, y0, x1, y1 = bbox(s)
            age = (now - s.get("t0", now)) / 1000
            print(f"{s.get('id')}  {s.get('tool')}/{s.get('color')}  "
                  f"x={x0:.0f}..{x1:.0f} y={y0:.0f}..{y1:.0f}  {age:.0f}s ago")
        print(f"({len(strokes)} strokes total)")
        return

    if args.erase_ids:
        ids = set(args.erase_ids)
        doomed = [s for s in strokes if s.get("id") in ids]
    else:
        box = args.erase_box
        if args.erase_px:
            if not args.timeline:
                die("--erase-px needs --timeline")
            box = px_box_to_world(args.erase_px, args.timeline)
        doomed = [s for s in strokes if selected(s, box, args.mode)]
        print(f"world box: x={box[0]:.0f}..{box[2]:.0f} y={box[1]:.0f}..{box[3]:.0f}")

    for s in doomed:
        x0, y0, x1, y1 = bbox(s)
        print(f"erase {s.get('id')}  x={x0:.0f}..{x1:.0f} y={y0:.0f}..{y1:.0f}")
    if not doomed:
        print("nothing matched")
        return
    if args.dry_run:
        print(f"(dry run) would erase {len(doomed)} of {len(strokes)} strokes")
        return
    keep_ids = {id(s) for s in strokes} - {id(s) for s in doomed}
    kept = [s for s in strokes if id(s) in keep_ids]
    call("PUT", "/api/strokes", {"strokes": kept, "client": "claude"})
    print(f"erased {len(doomed)} stroke(s); {len(kept)} remain")


if __name__ == "__main__":
    main()
