---
name: connect
description: Connect this Claude session to the user's iPad canvas, giving it its own board, chat and voice on the iPad. Run when the user types /canvas:connect.
argument-hint: "[board name]"
disable-model-invocation: true
---

Connect this session to the user's canvas. The optional argument is a board name: `$ARGUMENTS`.

The agent tool is `"${CLAUDE_PLUGIN_ROOT}/canvas_agent.py"`, called `canvas_agent.py` below. Run it with `python`, or with `python3` where `python` isn't Python 3 (macOS, Linux).

1. **Check for a canvas:** run `canvas_agent.py setup`.
   - `CANVAS ok <address>`: go on.
   - `CANVAS down <address>`: the computer that hosts the canvas isn't answering. Tell the user, in one line, that their canvas PC seems to be off or offline (the canvas starts by itself when they log in there). Stop.
   - `CANVAS none`: this machine has never been connected. Ask the user for their canvas link. They get it on the computer that hosts the canvas, by running `/canvas:link` there, or in the iPad app under ☰ › App › Server link. Wait for them to paste it, then use it as `LINK` in step 2.
     - Only if the user says this machine should host the canvas itself, run `canvas_agent.py setup --host` instead, then go on.
2. **Connect:** run `canvas_agent.py connect [LINK] --auto "<name>"`.
   - `<name>` is the argument if one was given, else the current project folder's name.
   - If another Claude session is already listening on that board, the tool picks `<name>-2` and so on.
   - Note the board id it prints (the `-s` value).
3. **Listen:** start `canvas_agent.py wait -s <board>` as a background command. It exits when the user sends something from the canvas. Handle it as the `canvas` skill says, then start `wait` again. Keep exactly one `wait` running for this board.
4. **Tell the user**, in three or four short lines:
   - The board name, and that it's on their iPad now. Canvas shows a "New board" note to tap, or they can pick it from the board switcher at the top of the chat panel.
   - A new iPad, or the app's first run: `/canvas:link` gives the link to paste into the app.
   - To follow this session in the Claude app too: `/remote-control` (or turn it on for every session once in `/config`).
   - Chat copying is off: answers go where the user writes. They can say "copy our chat to the canvas" to turn it on (see the `canvas` skill).
