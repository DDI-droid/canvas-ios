"""UserPromptSubmit hook: a prompt typed in Claude Code also appears in the canvas chat.

Only for a Claude Code session attached to a canvas session (see _mirror.py). Prints nothing:
anything this hook printed would be added to Claude's context.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mirror import attached_target, is_typed_prompt, mark_turn, post_mirror, read_stdin_json  # noqa: E402

data = read_stdin_json()
claude_id = data.get("session_id") or ""
prompt = data.get("prompt") or ""
if claude_id and is_typed_prompt(prompt):
    target = attached_target(claude_id)
    if target and post_mirror(target, "user", prompt):
        mark_turn(claude_id)  # so the Stop hook mirrors this turn's answer
sys.exit(0)
