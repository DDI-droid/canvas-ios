#!/usr/bin/env python3
"""Place SVG drawings on the canvas "Claude layer" (world coordinates).

  python canvas/draw.py --svg path.svg --x 100 --y 200 [--width 400] [--label "..."] [--id my-id]
  python canvas/draw.py --svg - --x 0 --y 0 < drawing.svg      # read SVG from stdin
  python canvas/draw.py --list
  python canvas/draw.py --remove <id>
  python canvas/draw.py --clear

x/y is the top-left corner in world units; width is in world units (height follows the
SVG's aspect ratio). Re-using an --id replaces that item. Use the "World mapping" line
in a message's timeline.txt to convert snapshot pixels to world coordinates.
"""
from __future__ import annotations

import argparse

from _client import call, die, read_file, read_stdin, setup_utf8


def main() -> None:
    setup_utf8()
    ap = argparse.ArgumentParser(description="Draw SVG on the canvas Claude layer")
    ap.add_argument("--svg", help="path to an .svg file, or '-' for stdin")
    ap.add_argument("--x", type=float, default=0.0, help="world x of the top-left corner")
    ap.add_argument("--y", type=float, default=0.0, help="world y of the top-left corner")
    ap.add_argument("--width", type=float, help="width in world units (default: SVG's own)")
    ap.add_argument("--height", type=float, help="height in world units (default: from aspect)")
    ap.add_argument("--label", help="optional caption shown under the drawing")
    ap.add_argument("--id", help="optional id (re-use to replace an item)")
    ap.add_argument("--remove", metavar="ID", help="remove the item with this id")
    ap.add_argument("--clear", action="store_true", help="remove all Claude-layer items")
    ap.add_argument("--list", action="store_true", help="list current Claude-layer items")
    ap.add_argument("--port", type=int, help="server port (default: from data/server.json or 8765)")
    args = ap.parse_args()

    if args.clear:
        res = call("POST", "/api/draw/clear", {}, port=args.port)
        print(f"cleared {res.get('removed', 0)} item(s)")
        return
    if args.remove:
        call("POST", "/api/draw/remove", {"id": args.remove}, port=args.port)
        print(f"removed {args.remove}")
        return
    if args.list:
        state = call("GET", "/api/state", port=args.port)
        items = state.get("claude_layer") or []
        if not items:
            print("(Claude layer is empty)")
        for it in items:
            print(f"{it.get('id')}: x={it.get('x')} y={it.get('y')} width={it.get('width')} "
                  f"label={it.get('label')!r} svg={len(it.get('svg') or '')} chars")
        return
    if not args.svg:
        die("--svg is required (or use --clear / --remove / --list)")
    svg = read_stdin() if args.svg == "-" else read_file(args.svg)
    if "<svg" not in svg.lower():
        die("input does not look like SVG (no <svg> element)")
    payload = {"svg": svg, "x": args.x, "y": args.y}
    if args.width:
        payload["width"] = args.width
    if args.height:
        payload["height"] = args.height
    if args.label:
        payload["label"] = args.label
    if args.id:
        payload["id"] = args.id
    res = call("POST", "/api/draw", payload, port=args.port)
    print(f"drew {res.get('id')} at ({args.x:g}, {args.y:g})")


if __name__ == "__main__":
    main()
