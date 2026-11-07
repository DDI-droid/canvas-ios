"""UserPromptSubmit hook: mirror the user's main-chat message into the canvas chat."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mirror import post_mirror, read_stdin_json  # noqa: E402

data = read_stdin_json()
prompt = data.get("prompt") or ""
# Skip slash commands; they aren't conversation.
if prompt.strip() and not prompt.lstrip().startswith("/"):
    post_mirror("user", prompt)
sys.exit(0)
