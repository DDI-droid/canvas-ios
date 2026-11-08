"""Stop hook: Claude's answer to a prompt typed in Claude Code also appears in the canvas chat.

Only for turns the prompt hook marked (typed prompts in an attached session); see _mirror.py.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mirror import attached_target, final_text, post_mirror, read_stdin_json, take_turn  # noqa: E402

data = read_stdin_json()
claude_id = data.get("session_id") or ""
if claude_id and take_turn(claude_id):
    target = attached_target(claude_id)
    if target:
        post_mirror(target, "claude", final_text(data))
sys.exit(0)
