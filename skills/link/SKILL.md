---
name: link
description: Print the link to the user's canvas, for setting up a new iPad or connecting Claude on another machine. Run when the user types /canvas:link.
disable-model-invocation: true
---

Run `python "${CLAUDE_PLUGIN_ROOT}/canvas_agent.py" link` (or `python3`). If it says nothing is configured, this machine hasn't been connected: suggest `/canvas:connect` first.

Give the user the first line it prints, exactly as printed, in a code block, with two short notes:
- Paste it into the Canvas app on a new iPad (☰ › App › Server link), or give it to `/canvas:connect` on another machine when it asks.
- It contains the canvas's secret key. It's for their own devices only: never put it in a file, a commit or a shared message.
