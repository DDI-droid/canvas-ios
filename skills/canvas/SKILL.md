---
name: canvas
description: Work with the user's iPad canvas once this session is connected (after /canvas:connect). Use when a message arrives from it (the background `canvas_agent.py wait` prints "MSG <id> | session <board>"), or when the user mentions the canvas, the iPad, the board, drawing on it, or putting something there.
---

# Working with the canvas

The user has an iPad canvas: an infinite board they draw on with Apple Pencil, a chat panel, and hands-free voice. This session has its own board on it (its id is the `-s` value from `/canvas:connect`). The tool is `python "${CLAUDE_PLUGIN_ROOT}/canvas_agent.py"` (or `python3`), called `canvas_agent.py` below. Always pass `-s <board>`; other boards belong to other Claude sessions.

## Where to answer: where the user wrote

- **A message from the canvas** comes from the background `wait`. It prints the text, a snapshot of the board (a PNG: open it, since new ink is drawn at full strength and older ink faded) and a timeline of what they said and drew, with the pixel-to-world mapping.
  - Answer on the canvas: write markdown to a **new** file, then `canvas_agent.py say -s <board> --file reply.md`. KaTeX works (`$x^2$`).
  - In this chat, mark it so the user can tell the two apart: one line, `📱 From the canvas: "<their words>"`, then a one-line summary of your answer.
  - Then start `wait` again (in the background). Keep exactly one `wait` per board.
- **A message typed here** (Claude Code, the Claude app): answer here, as usual.
  - Copy it to the canvas only if the user asked for chat copying on this board. Turn it on with `canvas_agent.py mirror -s <board> on` (`off` to stop; no state shows it).
  - While it's on, end each such turn by writing their prompt and your answer to two **new** files and running `canvas_agent.py copy -s <board> --prompt-file p.md --answer-file a.md`.
  - There are no hooks for this: hooks would run on every turn of every session, and starting a process costs seconds on some machines.
- Messages that start with 🎙 were spoken. The canvas's voice assistant passes them on, and `(heard: "…")` shows the user's own words. While voice mode is on, the gist of your reply is read out, so put it in the first sentence.

## Use the board, not just the chat

The board is the user's main medium. When they draw or write, answer there too:
- Draw an SVG at their ink, in world coordinates, using the timeline's view and mapping: `canvas_agent.py draw -s <board> --svg fig.svg --x X --y Y --width W --label "what it shows"`. Also `--list`, `--remove ID` and `--clear`.
  - Set a `viewBox`, `font-family="-apple-system, system-ui, sans-serif"`, dark text `#1d1d1f`, blue `#0a84ff`, red `#ff3b30`, and text at least 16 px. No scripts.
- Put things on the board as cards. Without `--x/--y` a card lands in the middle of the user's view, or the nearest free spot, so it never covers another card. The user taps a card to move or resize it, and double-taps it to open it full screen.
  - An image, a video or a 3D model: `canvas_agent.py embed -s <board> --file plot.png|clip.mp4|part.glb --label "what it shows"`.
  - A chart that grows live: `canvas_agent.py chart -s <board> --data d.json`, with `{type: line|bar|scatter|area, title, x: [...], series: [{name, y: [...]}]}`. Add points with `canvas_agent.py update -s <board> --id CARD --data more.json --append`.
  - A live, interactive page (a demo, a simulation, a small tool, a report): `canvas_agent.py page -s <board> --file demo.html --label "..."`. It runs on the iPad itself, so prefer it to `browse` for HTML you have: it's instant and smooth even on cellular. Its outside links open in the same card as a live browser, with ‹ back to the page. It runs sandboxed. It can load `/vendor/three/...` and `/vendor/chartjs/...` from the canvas, and it gets live data from `update` with `window.addEventListener('canvas:data', e => e.detail.data)`.
  - A live website: `canvas_agent.py browse -s <board> --url example.com`. It's a real Chrome tab on the PC, streamed into the card; the user taps and scrolls it. Links that open a new tab open in the same card. If a site won't sign in there (Google), run `canvas_agent.py signin --url accounts.google.com`: a normal Chrome window opens on the PC; the user signs in and closes it, and the cards come back signed in.
- Keep the chat reply short and point to what you put on the board. The first sentence should stand on its own; end with one clear question when you need their input.

## Show progress while you work

For a canvas request that takes more than a moment, post short progress notes: `canvas_agent.py note -s <board> "Found why the loss spikes; fixing it"`.
- One note per meaningful step (something you found, changed or tested), usually 4 to 8 for a piece of work.
- A few plain words each. No tool names, commands, file paths or arguments.
- They fold into "N steps" above your reply and are never spoken.

## Rules

- The canvas link contains the user's secret key. Never write it into files, commits or messages to anyone else.
- If the canvas stops answering, the tool follows it to its new address by itself. If it still can't reach it, the PC hosting the canvas is off: tell the user once and stop waiting.
- Full reference, served by the canvas itself: `<canvas address>/agent?k=<key>&s=<board>`.
