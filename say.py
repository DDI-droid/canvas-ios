#!/usr/bin/env python3
"""Send a markdown reply to the canvas chat overlay.

  python canvas/say.py "markdown text"          # text as argument(s)
  python canvas/say.py - < reply.md             # '-' (or no argument) reads stdin
  python canvas/say.py --file reply.md
  python canvas/say.py --status "still working" "partial answer"

KaTeX math is supported in the page: $inline$ and $$display$$.
Tip (Git Bash): use single quotes or a quoted heredoc so `$x$` is not expanded by the shell:
  python canvas/say.py - <<'EOF'
  The scale is $s = \\max|x| / 127$.
  EOF
"""
from __future__ import annotations

import argparse
import sys

from _client import call, die, read_file, read_stdin, setup_utf8, add_session_arg, use_session


def main() -> None:
    setup_utf8()
    ap = argparse.ArgumentParser(description="Post a markdown reply to the canvas overlay")
    ap.add_argument("text", nargs="*", help="markdown text ('-' or nothing = read stdin)")
    ap.add_argument("--file", "-f", help="read markdown from this UTF-8 file")
    ap.add_argument("--status", help="status to set after the reply (default: idle)")
    ap.add_argument("--port", type=int, help="server port (default: from data/server.json or 8765)")
    add_session_arg(ap)
    args = ap.parse_args()
    use_session(args)

    if args.file:
        text = read_file(args.file)
    elif args.text and args.text != ["-"]:
        text = " ".join(args.text)
    else:
        if sys.stdin is None or sys.stdin.isatty():
            die("no text given (pass text, '-' with stdin, or --file)")
        text = read_stdin()
    if not text.strip():
        die("reply text is empty")
    payload = {"text": text}
    if args.status:
        payload["status"] = args.status
    res = call("POST", "/api/reply", payload, port=args.port)
    print(f"delivered reply {res.get('id')} ({len(text)} chars)")


if __name__ == "__main__":
    main()
