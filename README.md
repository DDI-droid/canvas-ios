# Canvas

An iPad-first infinite canvas for thinking with Claude. Draw with Apple Pencil, talk through the
mic while you draw, and **Send**: Claude Code (running on this machine) gets a PNG snapshot of the
board (new ink at full strength, older ink faded), a timeline of what you said and drew, and the
text. Claude's replies appear in a translucent chat overlay, and Claude can place SVG drawings on
the board ("Claude layer").

There are **two ways to use it**, and both use the same page and server:

1. **In Safari** (any iPad, no install). Open the canvas link, which ends in `?k=…`. Safari only
   offers Apple's basic voices.
2. **The Canvas iPad app** (`ios/`). It wraps the same page with Apple's native speech
   recognition, every installed voice (including the Premium ones Safari hides), no browser bar,
   and Apple Pencil double-tap and squeeze. GitHub Actions builds it (`.github/workflows/build.yml`),
   SideStore installs it, and you re-sign it every 7 days. The server offers the build at
   `/app/Canvas.ipa` and a SideStore source at `/app/source.json`.

## The Claude Code plugin (one repo, two installs)

This repo is also a Claude Code plugin. On every machine where you run Claude Code (this PC, another
computer, a cloud server you log into), install it once:

```
/plugin marketplace add https://github.com/DDI-droid/canvas-ios.git
/plugin install canvas@ddi-canvas
```

The repo is public, so installing needs no GitHub sign-in. (Pushing does: on the PC that hosts
the canvas, git signs in through the repo's own credential helper.) To pick up a new version
later, run `claude plugin marketplace update ddi-canvas`. Setting up a new machine and the state
of the work: `HANDOFF.md`.

Then, in any session:

1. `/remote-control`, to follow the session from the Claude app too. Or turn it on for every
   session once, in `/config`.
2. `/canvas:connect [board name]`. Claude gives the session its own board, named after the project
   folder (with `-2`, `-3`… if another session is already listening on it), and starts listening.
   The iPad shows a "New board from Claude · Open" note.
   - The first time on a machine that doesn't host the canvas, it asks for your canvas link. Get it with
     `/canvas:link` on the PC that hosts it, or in the app under ☰ › App › Server link. After that the
     machine remembers it, and follows the canvas when its address changes (the secret gist).
   - On a machine that should host the canvas itself, Claude can start one there
     (`canvas_agent.py setup --host`, with data in `~/.canvas`).
3. `/canvas:link` prints the link for a new iPad, or for Claude on another machine.

Claude answers where you write: canvas messages on the canvas (marked "📱 From the canvas" in the
Claude Code chat), typed prompts in Claude Code. Ask it to "copy our chat to the canvas" to also
see the Claude Code conversation on the board's chat.

The plugin has no hooks, so it adds nothing to sessions that don't use it, beyond about 240 tokens of
skill descriptions. (Starting a process can take seconds on some machines, and hooks would do that
on every turn.)

Sessions in the browser at claude.ai/code don't load plugins. Everywhere you run Claude Code
yourself, the plugin works, as long as the PC hosting the canvas is on.

**Several Claude sessions at once.** Each Claude Code session, whether on this PC, another machine
or in the cloud, gets its own canvas *session*: a board, chat and voice talker of its own. Switch
between them from the Claude panel's title. To attach a session, make a new session in that menu
(or tap **Connect** next to an existing one) and paste the line it gives you into the Claude session:

> Connect to my canvas as session "research". Follow the instructions at `https://…/agent?k=…&s=research`

The instructions page serves `canvas_agent.py`, a one-file Python client. The agent connects, then
loops: `wait` for your next message, read the board snapshot, `say` a reply, and wait again. A cloud
session must be allowed to reach the tunnel host.

Files:

- `server.py` – Python stdlib HTTP server (no dependencies). Binds **127.0.0.1 only**.
- `canvas_agent.py` – the client any Claude session uses to attach to a canvas session (served at `/agent/canvas_agent.py`).
- `say.py`, `status.py`, `draw.py`, `ink.py` – stdlib helper CLIs Claude uses to talk back and edit the board.
- `talker.py`, `voice_mcp.py` – the live voice "talker" (Claude Haiku via Claude Code) and its tools.
- `static/` – the web app (vanilla ES modules, no build step; libraries vendored in `static/vendor/`).
- `ios/` – the iPad app (XcodeGen project, Swift).
- `data/` – runtime state: the access key, chats, board and logs (git-ignored, never committed).

## Run

```bash
python canvas/server.py              # default port 8765
python canvas/server.py --port 9000  # other port (helpers find it via data/server.json)
python canvas/server.py --quiet      # only print the startup banner
```

On first run a secret token is generated into `data/token.txt`. Startup prints:

```
Canvas server running
  URL:    http://127.0.0.1:8765/?k=<token>
  Token:  <token>
  Events: C:\...\canvas\data\events.log
```

Open the URL locally, or expose `127.0.0.1:8765` through an HTTPS tunnel and open
`https://<tunnel-host>/?k=<token>` on the iPad. HTTPS is required for the microphone. To install
it, use Safari's **Share › Add to Home Screen** *from that URL* – the key stays in the start URL
(Home Screen apps have their own cookie/localStorage jar).

### Auth

Every route (page, static files, API, SSE) requires the token, compared in constant time:

- `?k=<token>` query parameter, or
- `X-Canvas-Key: <token>` header, or
- the `canvas_k` cookie (HttpOnly, SameSite=Lax; `Secure` when `X-Forwarded-Proto: https`) that the
  server sets when the page is loaded with a valid key. This is what lets ES-module imports and
  KaTeX fonts (which cannot carry a query parameter) load.

Anything else gets `401`. Request bodies are capped at 25 MB (`413`). Static files are served only
from `static/` (no traversal, explicit MIME map). The page is served with a strict CSP
(`script-src 'self'`, no external origins).

## Getting notified: `data/events.log`

For every message the user sends, the server appends **exactly one line** (UTF-8, `\n`, flushed and
fsynced) and writes nothing else to this file, ever:

```
MSG <id> | <text, newlines collapsed to " / ", max 500 chars> | img=<abs path to snapshot.png> | timeline=<abs path to timeline.txt>
```

Example:

```
MSG 20261106-153012-ab12 | so the scale is max over 127 / is σ right? | img=C:\Users\...\canvas\data\inbox\20261106-153012-ab12\snapshot.png | timeline=C:\Users\...\canvas\data\inbox\20261106-153012-ab12\timeline.txt
```

The text itself may contain `|`; parse `img=` / `timeline=` from the right. A drawing-only
message has an empty text field (`MSG <id> |  | img=…`).

Tail it with e.g. `tail -n0 -F canvas/data/events.log` (Git Bash).

### Inbox

`data/inbox/<id>/`:

| file | contents |
|---|---|
| `snapshot.png` | Board snapshot, longest side ≤ 2000 px, paper background, light-theme colours. Ink drawn since the previous message is full strength; older ink at 35 %; Claude-layer drawings at ~55 %. |
| `timeline.txt` | Human-readable timeline (below). |
| `message.json` | `{id, received_at, text, board_image_mode, snapshot, snapshot_path, timeline_path, timeline (structured), client_ts, cid}` |

`timeline.txt` (times are seconds relative to the first event of this message, sorted by start;
ink boxes are in snapshot pixels; strokes less than 1.5 s apart are merged):

```
Snapshot 2000x1390 px (view mode). New ink is full strength, older ink faded.
[00:00.0–00:04.2] speech: "so the scale is max over 127"
[00:01.1–00:03.0] ink (blue) at x=410..720, y=220..300
[00:05.2–00:05.9] ink (yellow highlighter) at x=380..760, y=290..318

World mapping (for draw.py): world_x = -120.0 + px_x / 1.6949, world_y = 40.0 + px_y / 1.6949
User's current view in world units: x=-120..1060, y=40..860

Message text (as sent):
so the scale is max over 127
```

Mode is `view` (what the user sees) or `board` (fit all content); the user picks it next to
Send. Extra lines that may appear: `No new ink since the previous message …`,
`Claude-layer drawings are included at reduced opacity.`, `… outside the snapshot` for new ink
that is off-screen in view mode.

## Talking back (helper CLIs)

All read `data/token.txt`, talk to `127.0.0.1` (port from `data/server.json`, `--port`,
`CANVAS_PORT`, or `CANVAS_URL`), bypass system proxies, and handle UTF-8 (math symbols, emoji).

```bash
# reply (markdown; KaTeX: $inline$, $$display$$, \( \), \[ \])
python canvas/say.py - <<'EOF'
The scale is $s = \max_i |x_i| / 127$ ✓
EOF
python canvas/say.py 'short reply σ ✓'          # argument form
python canvas/say.py --file reply.md             # from a UTF-8 file
python canvas/say.py --status "still checking" - < partial.md   # reply + keep a status

# status pill ("Claude is thinking…" shimmer)
python canvas/status.py thinking
python canvas/status.py "Reading your derivation…"
python canvas/status.py idle

# Claude layer (world coordinates; x/y = top-left; width in world units, height from aspect)
python canvas/draw.py --svg note.svg --x 600 --y 200 --width 360 --label "scale" --id scale-note
python canvas/draw.py --svg - --x 0 --y 0 < drawing.svg
python canvas/draw.py --list
python canvas/draw.py --remove scale-note
python canvas/draw.py --clear
```

**Git Bash quoting:** use single quotes or a quoted heredoc (`<<'EOF'`) so `$x$` is not expanded
by the shell, and avoid passing text that *starts with `/`* as an argument – MSYS rewrites it into a
Windows path (`"/2 is half"` → `C:/…/Git/2 is half`). The stdin/heredoc form is always safe
(or set `MSYS_NO_PATHCONV=1`). In Windows PowerShell 5.1, piping non-ASCII text into Python is lossy;
use arguments or `--file` there.

A reply resets the status to `idle` (or to `--status`). After the user sends, the page shows
"Claude is thinking…" until a reply or a status arrives.

### Drawing on the Claude layer

- Coordinates are **world units** (1 unit = 1 CSS px at 100 % zoom). Convert snapshot pixels with
  the `World mapping` line of the message's `timeline.txt`.
- Give the SVG a `viewBox`; it is scaled to `width` (or the SVG's own width). Re-using `--id`
  replaces an item in place.
- SVG is sanitized in the page (DOMPurify SVG profile): no scripts, event handlers, `<image>`,
  `<foreignObject>`, `<a>`, SMIL animation, or external `url()`/`href` (only `#fragment` refs).
  `<style>` is allowed and scoped (each item renders in its own shadow root).
- In dark mode the layer is shown colour-inverted (hue preserved), so draw for a light background.
- The user can hide the layer, clear it, or long-press (finger) an item to remove it.

## HTTP API

All JSON bodies are UTF-8; all routes need the token.

| method & path | body → response |
|---|---|
| `GET /` | the app (index.html with the key templated in; sets the auth cookie) |
| `POST /api/message` | page → Claude: `{text, image: "data:image/png;base64,…", timeline, board_image_mode: "view"\|"board", cid?, client_ts?}` → `{id}`. Writes inbox files, appends to `conversation.json`, appends one `events.log` line, sets status `sent`. |
| `POST /api/reply` | `{text: markdown, status?}` → `{id}`; appends a `claude` message, pushes SSE `reply`, sets status (default `idle`). |
| `POST /api/status` | `{status: "thinking"\|"idle"\|<short text>}` → `{ok, status}`; pushes SSE `status`. |
| `POST /api/draw` | `{svg, x, y, width?, height?, id?, label?}` → `{id}`; upserts into `claude_layer.json`, pushes SSE `draw`. |
| `POST /api/draw` (cards) | `{type: image\|video\|page\|browser, src\|page\|browser, aspect?, x?, y?, width?, label?, view?}`; without x/y the card goes in the middle of the view or the nearest free spot. |
| `POST /api/media` | raw body (image, video, 3D model; up to 1 GB) → `{src}`; `POST /api/media/poster?for=<file>` a video's first frame. |
| `POST /api/page` | `{html}` or `{template: chart\|model, data}`, `title?` → `{page, src}`; served keyless at `/live/<token>/` (sandboxed, with `live-bridge.js`). |
| `POST /api/card/browse` | `{id, url}` → a page card's outside link opens in the same card as a live browser (`browsing`); `POST /api/card/back {id}` returns to the page. |
| `POST /api/card/data` | `{id\|page, data, mode: replace\|append}` → live data into the card's page (`canvas:data` event). |
| `POST /api/browser` | `{url, label?}` → a browser card (headless Chrome on this PC, `browser.py`); `GET /api/browser/<tab>/frame?after=N` (JPEG long-poll), `POST /api/browser/<tab>/input`. |
| `POST /api/browser/signin` | `{url?}` → opens a normal Chrome window on the PC with the browser cards' profile (sites that won't sign in a hidden browser); cards pause until it's closed. |
| `POST /api/draw/remove` | `{id}` → `{ok}` (404 if unknown); also `DELETE /api/draw/<id>`. Pushes `draw_remove`. |
| `POST /api/draw/clear` | `{}` → `{ok, removed}`; pushes `draw_clear`. |
| `PUT /api/strokes` | page → server (debounced): `{strokes: [...], client}`; persists `strokes.json`, pushes `strokes`. |
| `GET /api/state` | `{conversation, strokes, claude_layer, status, server_time}` |
| `GET /api/inbox/<id>/snapshot.png` | the stored snapshot (used for chat thumbnails) |
| `GET /api/ping` | `{ok, time, clients}` |
| `GET /api/events` | Server-Sent Events: `hello`, `message`, `reply`, `status`, `draw`, `draw_remove`, `draw_clear`, `strokes`; `: keepalive` comment every 15 s; `retry: 3000`. Multiple clients; disconnects are cleaned up. |

Conversation entries: `{id, role: "user"|"claude", text, ts, …}`; user entries also carry
`image`, `mode`, `width`, `height`, `cid`, `client_ts`.

Stroke format (page-owned): `{id, tool: "pen"|"hl", color, size, t0, t1, mt?, sim?, pts: [x, y, pressure, …]}`
in world units; `color` is a palette key (`ink, blue, red, green, orange, purple, teal, yellow`).

## Data directory

| file | |
|---|---|
| `token.txt` | auth token (keep it secret; delete to rotate) |
| `events.log` | notification lines (above) |
| `conversation.json` | chat history (list) |
| `strokes.json` | user ink (list) |
| `claude_layer.json` | Claude-layer items (list) |
| `inbox/<id>/` | per-message files |
| `server.json` | `{host, port, pid, started}` of the running server |

## Using the app

- **Pencil** draws (pressure-sensitive, perfect-freehand ink). **Fingers** pan (one or two) and
  pinch-zoom; **two-finger tap = undo, three-finger tap = redo**. Once a Pencil is seen, touches never
  draw (palm rejection). For testing without a Pencil enable *Settings › Draw with finger*.
- Tools: pen, highlighter, stroke eraser, lasso (select → drag to move, duplicate, delete, tap a colour
  to recolour), 8 colours, 3 widths, undo/redo. Pencil hover shows a size preview (M2+ iPads).
- Keyboard: `P/H/E/L` tools, `1–8` colours, `[ ]` width, `⌘Z / ⇧⌘Z` undo/redo, `⌘↩` send,
  `M` mic, `F` fit, `0` 100 %, `Delete` removes the selection; mouse: wheel pans, ⌘/Ctrl-wheel zooms,
  Space-drag or middle-drag pans.
- **Cards** (images, videos, 3D models, charts, live pages, browser tabs): tap a card to select it
  (drag to move, corners to resize), double-tap to open it full screen, ✕ to come back. On live
  cards a finger *uses* the content (play, scroll, tap links, turn the model) and the title strip
  arranges it; the Pencil always draws over everything. **+** adds images, videos and 3D models
  (glb, gltf, obj, stl). Off screen, live cards rest (pages pause, browsers stop streaming).
- **Mic**: toggles Web Speech recognition (continuous, interim results, auto-restart). Final speech
  lands in the composer; live words show above it. You can keep drawing while listening.
- **Send** (bottom-left arrow or the composer's arrow) captures the snapshot + timeline and posts it.
  *View* sends what you see; *Board* sends everything.
- Chat overlay: drag the header to float it (double-tap header or ⧉ to dock), resize from the
  bottom-left grip, width presets, opacity, **pass-through** (ghost) so ink goes under it, collapse to
  a pill with an unread badge. Settings (top-left): dark mode, finger drawing, speech language
  (en-US / en-IN / en-GB), Claude-layer visibility, fit, clear Claude's drawings, clear board (undoable).

## Known limitations

- **Web Speech on iPad Safari** is Apple's dictation service: needs HTTPS, mic + speech permission and
  *Siri & Dictation* enabled; it stops on silence / after ~1 min, so the app auto-restarts it while the
  mic is on (a brief gap can drop a word). iOS may re-ask for mic permission per page load, and some
  versions refuse restarts that are not triggered by a tap – the mic then shows an error and one tap
  resumes. In Home Screen (standalone) mode speech recognition has historically been flaky or
  unavailable; if so, use Safari or the keyboard's dictation key in the composer (the fallback when the
  API is missing). The level meter is synthetic (driven by recognition events) because opening a second
  audio capture conflicts with recognition on iOS.
- **Home Screen mode**: separate storage from Safari (add it from the `?k=` URL); after the app is
  backgrounded the SSE connection is re-established and state re-synced automatically.
- Apple Pencil double-tap / squeeze and the Pencil Pro barrel roll are not exposed to web pages.
- `getCoalescedEvents` / `getPredictedEvents` are used when the browser supports them (Chrome, recent
  Safari); otherwise one point per pointer event.
- Multiple devices: chat and Claude layer sync live; ink syncs last-writer-wins (no merging).
- Ink is persisted as a whole on every change (debounced); very large boards (tens of thousands of
  strokes) will make saves slow.

## Development & tests

No build step. Syntax-check modules with `node --check static/<file>.js`. The vendored libraries and
their licenses are in `static/vendor/`: perfect-freehand 1.2.3 (MIT), marked 18.1.3 (MIT),
DOMPurify 3.4.17 (Apache-2.0 / MPL-2.0, used under Apache-2.0), KaTeX 0.19.1 (MIT, woff2 fonts).

## Additions (main agent)

- **Long-polling:** `GET /api/poll?since=<seq>&epoch=<id>&wait=25` returns `{epoch, next, reset, events:[{seq, event, data}], status}`. The page uses this instead of SSE because Cloudflare quick tunnels buffer SSE. `/api/events` still works on localhost.
- **Chat mirror:** `POST /api/mirror {role: "user"|"claude", text}` adds a main-chat turn to the canvas conversation without touching `events.log`. It is used by `hooks/mirror_prompt.py` (UserPromptSubmit) and `hooks/mirror_reply.py` (Stop).
  - They mirror only for a Claude Code session attached to a canvas session (`canvas_agent.py wait`/`connect` records it in `~/.canvas_agent/attached.json`), only into that session, and only turns that began with a typed prompt.
  - To install them, add this to `training/.claude/settings.local.json` (or use `/hooks`):
    ```json
    "hooks": {
      "UserPromptSubmit": [{ "hooks": [{ "type": "command", "timeout": 10,
        "command": "python \"C:/Users/AnshulThakur/Documents/training/canvas/hooks/mirror_prompt.py\"" }] }],
      "Stop": [{ "hooks": [{ "type": "command", "timeout": 15,
        "command": "python \"C:/Users/AnshulThakur/Documents/training/canvas/hooks/mirror_reply.py\"" }] }]
    }
    ```
- **Ink as changes:**
  - `POST /api/ink {client, ops}`, where ops are `{op: "put", s: stroke, after: id|null}` or `{op: "del", id}`. Returns `{rev}`, and every page gets an `ink` event `{rev, client, ops}`.
  - `GET /api/ink?since=REV&id=BOARD` returns `{id, rev, batches}`, or `{id, rev, strokes}` when the page is too far behind or holds a copy of another board. Pages keep a copy of the board on the device (IndexedDB), so opening is instant.
- **Automatic updates:** each poll carries `build`. Pages reload by themselves once idle and keep their undo history and draft. Polls also carry `app.version`, so the iPad app says when a new build is ready in SideStore.
  - Changes go to `strokes.ops.jsonl` at once, and `strokes.json` (`{rev, strokes}`) is rewritten every 5 s.
- **Light state:** `GET /api/state?conv=N&strokes=0` returns the latest N chat entries (`conversation_more`), no ink, plus `ink_rev`. Older entries come from `GET /api/conversation?before=ID&limit=N`.
- **Media:** `POST /api/media` also takes the image itself (`Content-Type: image/…`). `GET /api/media/<hash>.preview.jpg` is a 1280 px copy, made on first request (Pillow).
- **Messages:** `POST /api/message` with a `cid` the server already has returns the existing id (`duplicate: true`) and delivers nothing new.
- **Cards:** `POST /api/draw/move {id, x, y, width?, height?}` moves or resizes a Claude-layer item and broadcasts `draw_move` (pages reposition it without re-rendering). `GET /api/state` also returns `events: {epoch, seq}`, the cursor the page resumes its event stream from.
- **Erasing the user's ink:** `python canvas/ink.py --list | --erase-ids ID… | --erase-box X0 Y0 X1 Y1 | --erase-px X0 Y0 X1 Y1 --timeline <timeline.txt>`, with `[--mode inside|center] [--dry-run]`. It saves the filtered stroke list with `PUT /api/strokes` (client `"claude"`), and the page reloads it.
- **Full screen:** the top-bar button uses the Fullscreen API on iPadOS Safari.
  - Safari adds its own one-finger swipe-down gesture that exits full screen, and pages can't block it.
  - So in full screen, `[data-scroll]` panels also scroll with two fingers.
  - An accidental swipe-exit (a touch cancelled by Safari just before the exit) is undone by the next tap anywhere.
- **☰ menu (Claude panel header):** `#btnMenu` opens `#menuPop`. It holds:
  - Paper: Dots, Grid, Lines or Plain. Stored in `prefs.paper` and applied with `board.setPaper()`. The patterns are in `app.css` under `.paper[data-paper=…]`.
  - Appearance: Light, Dark or Auto. Stored in `prefs.theme`, where `null` means Auto.
  - Both are saved per device in localStorage. Snapshots sent to Claude are unaffected, because they are always rendered on plain light paper.
  - The "Dark appearance" switch was removed from the top-left settings popover.
- **Live voice conversation:** the orb next to Send turns on hands-free mode, and `static/live.js` drives the page side:
  - It detects the end of your turn, speaks replies with `speechSynthesis`, stops when you talk over it, and filters out its own echo.
  - The server's `talker.py` keeps one Claude Haiku session open through Claude Code headless (`claude -p --input-format stream-json --output-format stream-json`), on the user's subscription with no API key.
  - Endpoints:
    - `POST /api/talk` with `{kind: utterance|main_reply|board|warmup, text?, image?, interrupted?, log?}` returns `{turn, mode: say|silent|look|delegate, task, say}` as soon as the first sentence is ready.
    - Further sentences and `{done:true, mode, task, text, ms, first_ms}` arrive as `talk` events.
    - `POST /api/talk/reset` restarts the talker.
  - Hand-offs go to the main agent as normal `/api/message` posts with text `🎙 <task>`. When the main agent replies, the talker speaks the gist.
  - The talker starts and warms up with the server. Typical latency is about 0.8–1 s from the end of your turn to the first spoken words, plus 0.42–0.65 s of silence detection.
- **Operating guide for Claude:** `.claude/skills/canvas/SKILL.md`.
