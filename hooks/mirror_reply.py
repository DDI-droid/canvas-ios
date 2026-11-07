"""Stop hook: mirror Claude's final reply of the turn into the canvas chat."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mirror import post_mirror, read_stdin_json  # noqa: E402


def final_text_from_transcript(path: str) -> str:
    """Text of the trailing assistant message(s) after the last tool call / user turn."""
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()[-400:]
    except OSError:
        return ""
    parts = []
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        etype = entry.get("type")
        if etype not in ("assistant", "user"):
            continue
        if etype == "user":
            break
        content = (entry.get("message") or {}).get("content")
        if isinstance(content, str):
            parts.append(content)
            continue
        if not isinstance(content, list):
            continue
        if any(isinstance(b, dict) and b.get("type") == "tool_use" for b in content):
            if parts:
                break
            # tool_use with no text after it: the turn's text (if any) is earlier
            texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
            if texts:
                parts.append("\n\n".join(texts))
            break
        texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if texts:
            parts.append("\n\n".join(texts))
    return "\n\n".join(reversed([p for p in parts if p.strip()]))


data = read_stdin_json()
text = data.get("last_assistant_message") or ""
if isinstance(text, dict):
    text = text.get("text", "")
if not text and data.get("transcript_path"):
    text = final_text_from_transcript(data["transcript_path"])
post_mirror("claude", text)
sys.exit(0)
