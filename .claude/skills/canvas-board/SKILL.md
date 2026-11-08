---
name: canvas-board
description: Use whenever you're attached to the user's iPad canvas (a canvas session: canvas_agent.py wait/say, 🎙 messages, board snapshots). How to talk through the board, not just the chat, and how you and the voice assistant share the work.
---

# Talking through the canvas

The user works on an iPad canvas: an infinite board they draw on with Apple Pencil, a chat panel,
and a hands-free voice assistant (Haiku). When a canvas session is active, **the board is the main
medium and the chat is secondary.** The user asked for this.

## When the user puts something on the board, answer on the board too

Each message comes with a board snapshot and a timeline. New ink is at full strength, and the
timeline gives the px→world mapping and their current view.

- **Answer in place.** Put your mark, correction or next step **next to their ink**, at the size of
  their handwriting. Don't put it on top of their ink.
- **Draw setups.** Draw a problem's diagram, axes or given quantities instead of describing them.
- **Keep the chat short.** One or two sentences that point at what you put on the board ("Marked
  your scale line in red").
- **Clean up.** Give drawings stable ids, and remove the ones that are resolved.

```bash
python canvas_agent.py draw -s <session> --svg fig.svg --x <world x> --y <world y> --width <w> --id <id> --label "…"
python canvas_agent.py draw -s <session> --list | --remove <id>
```

For SVGs, set a `viewBox`, use `font-family="-apple-system, system-ui, sans-serif"`, dark text
`#1d1d1f`, blue `#0a84ff`, red `#ff3b30`, and text at least 16 px at the drawn width. Don't use
scripts.

**Cards** (without `--x/--y` they land in the middle of the view, or the nearest free spot):

```bash
python canvas_agent.py embed  -s <session> --file plot.png|clip.mp4|part.glb --label "…"   # image, video, 3D
python canvas_agent.py chart  -s <session> --data d.json        # {type, title, x: [...], series: [{name, y: [...]}]}
python canvas_agent.py update -s <session> --id <card> --data more.json --append   # live points
python canvas_agent.py page   -s <session> --file demo.html     # a live, interactive page (sandboxed)
python canvas_agent.py browse -s <session> --url example.com    # a real Chrome tab, streamed live
python canvas_agent.py signin --url accounts.google.com         # sign the browser cards in, on the PC
```

## The voice assistant (Haiku) and you

- **What it does:** it talks with the user hands-free and sees their screen. It can write **short
  notes** on the board (a formula, a key term), which appear as "Voice note" cards at the top right
  of their view.
- **What it hands to you:** real work (checking work in depth, diagrams, marking up, code,
  experiments) comes to you as a **🎙 message**, with the user's words in `(heard: "…")`.
- **What happens to your replies:** while voice mode is on, Haiku **speaks the gist** of each one.
  Make the first sentence a standalone summary, and end with one clear question.
- **Don't fight over the board:** leave its Voice note cards alone unless the user asks, and keep
  your drawings clear of the top-right corner of their view.

## Progress and replies

- **Progress notes:** one for each meaningful step (a finding, a change, a test result), usually
  4–8 for a piece of work, each a few plain words with no tool names or file paths:
  `canvas_agent.py note -s <session> "Found the cause; fixing it"`. They fold into "N steps" above
  your reply.
- **Replies:** write markdown to a file first, then send it with `canvas_agent.py say -s <session>
  --file reply.md`. KaTeX math works: `$x^2$`.
- **Keep listening:** run `canvas_agent.py wait -s <session>` in the background again after every
  message.

To attach a new session: `<canvas origin>/agent?k=<key>&s=<name>` serves the full instructions and
the client.
