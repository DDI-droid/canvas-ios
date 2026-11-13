# Canvas: handoff (2026-11-13)

For a Claude Code session picking up the canvas work on another machine. Read this first, then
`README.md` (how the canvas works) and `skills/canvas/SKILL.md` (working with a board).

## 1. Set up a new machine

```bash
python3 --version                                    # the board tool needs Python 3, nothing else
curl -fsSL https://claude.ai/install.sh | bash       # Claude Code (Windows: irm https://claude.ai/install.ps1 | iex)
git clone https://github.com/DDI-droid/canvas-ios.git canvas
cd canvas
claude plugin marketplace add DDI-droid/canvas-ios   # the canvas plugin (this repo, public)
claude plugin install canvas@ddi-canvas
claude                                               # first run signs in: open the link it prints, paste the code back
```

Inside Claude: `/canvas:connect <name>`. It asks for the canvas link. The user gets it with
`/canvas:link` on the host, or in the iPad app under ☰ › App › Server link, and pastes it in.
The machine remembers the link and follows the canvas when its address changes.

## 2. Where things run

- **The host is the user's Windows laptop.** `supervisor.py` keeps `server.py --port 8765` and
  a Cloudflare quick tunnel running. Runtime state (key, chats, boards, logs) is in `data/` there.
- **The iPad** (the Canvas app, `ios/`) is only an input and display device.
- **This machine:** edit, commit, push to `main`. The host runs the code from its own clone.
  - Server or voice changes: on the host, `git pull`, then stop the `server.py` process (the
    supervisor starts it again within a second).
  - Page changes (`static/`) reach the iPad by themselves. The page updates itself when idle,
    and only the changed files download.
  - App changes (`ios/`) build on GitHub Actions. On the host, `python ios/fetch_build.py` checks
    the IPA and publishes it to the SideStore source; then the user updates in SideStore.
- **Real-stack tests** (iPad launches, voice turns, browser cards) only happen on the host.
- **The host runs three hidden Chromes:**
  - `browser.py`: browser cards, keeps the user's sign-ins
  - `pageshot.py`: pictures of live page cards
  - `boardrender.py` with `static/render.js`: pictures of the board for the voice and agents

## 3. State: done and measured

| Commit | What | Measured |
|---|---|---|
| 6868c2c | **Fast launch.** Per-file content versions plus an import map; files cached as immutable; the page served stale-while-revalidate with an ETag; a CSP hash for the inline import map; files under 4 KB padded so WebKit doesn't re-check them. App 1.5 launches with `.useProtocolCachePolicy`. | iPad: page from cache in 25–49 ms, ink at 0.09–0.11 s, ready at 0.4–0.57 s (before: 2.7 s, earlier 4–14 s). An update downloads only the changed files (3 of 23). |
| bf0d1a0 | **App builds.** A missing `import Foundation` had broken builds 5 and 6 without anyone noticing. CI now fails on a bad build, and `fetch_build.py` refuses an IPA with no app inside. | Build 7 (1.5) installed and running. |
| 5245a0f | **Change map.** 512-unit squares, a "seen" mark per viewer (voice, agent), and tiles of what changed. Voice tools `look_at_area` and `look_at_changes`; `canvas_agent.py look`; the change map printed in `wait`. | The voice described an off-screen drawing from the change map. |
| 6e8f991 | **Voice pictures drawn on the PC.** The iPad sends any waiting ink (`ink.settle`), then words and view. The PC draws the screen and the change map in one call. `render.js` keeps a copy of each board and syncs only changes (`/api/render/data?since&id&layer`). Outlines are made at load. Drawing uses the processor. Browser cards use `frame?peek=1`, which never opens a tab or waits. | Real iPad turns: ink sent in 0 ms, screen drawn in 15–27 ms. Screen plus change map: 49–80 ms on a 542-stroke board. |
| 5063ba4 | A turn's pictures count as seen only once the voice takes the turn. A cancelled turn's pictures come again with the next one. | Seen in the voice log on real turns. |

## 4. Next: browser streaming (the main task)

Start only when the user says go. They parked it "for next week" on 2026-11-13.

**Today:** `browser.py` drives the card's Chrome tab over CDP and streams screencast JPEGs. The
page fetches them with long-polls (`/api/browser/<tab>/frame?after=N&v=&w=&q=`). Cards run about
200–500 ms behind.

**Plan:** send the tab as hardware-encoded H.264 over WebRTC, straight over the Wi-Fi to the
app's page.
- The tunnel carries only signaling. Quick tunnels don't support SSE, so use WebSocket, long-poll
  or a single WHEP POST.
- Input goes back over a DataChannel.
- Claude keeps driving the same Chrome over CDP: clicks, typing, reading the page.
- Target: 50–120 ms behind, at 30–60 fps.

**Candidate ways to get the video:**
- **Chrome captures its own tab:** an MV3 extension's `tabCapture`, without a prompt via
  `--allowlisted-extension-id` and `--auto-accept-this-tab-capture` (the way puppeteer-stream
  does it).
- **Python:** aiortc for signaling and DataChannels. It encodes in software only, so GPU
  encoding would mean PyAV's `h264_nvenc`, `h264_qsv` or `h264_amf`. Capture with dxcam or
  windows-capture, not screencast JPEGs.
- **MediaMTX** (one binary, WHIP in, WebRTC/WHEP out), fed by ffmpeg `ddagrab` with a GPU
  encoder and B-frames off.

**Test these first on the host.** Each one decides the design:
1. Does `tabCapture` work under `--headless=new` on Windows? If not, use a normal Chrome window.
2. Does Chrome on Windows encode WebRTC on the GPU or in software? Check `encoderImplementation`
   in chrome://webrtc-internals.
3. Do the available PyAV wheels include the GPU encoders?
4. WKWebView: it has `RTCPeerConnection` and hardware H.264 (force H.264, not VP8). Use
   `<video playsinline muted autoplay>`. Check how its jitter buffer behaves (`jitterBufferTarget`
   only exists from iPadOS 27; the playout-delay header extension is unverified on Safari).
5. Connectivity: Windows Firewall must allow inbound UDP for the process on the host. Off the
   home Wi-Fi it needs TURN (Cloudflare's works over TCP/TLS on port 443).

**Never** ask the user to set up anything on the iPad for this. All setup happens on the host.

## 5. Smaller open items

- **"Checked" files on app launch:** on a fresh app launch, 14 of 23 files report as "checked"
  (each took 16 ms or less). WebKit on the PC shows none. Cause unknown; no visible cost.
- **Chat message pictures:** a chat message to Claude still builds its board picture on the iPad
  (`snapshot.js`, called from `app.js` `send`). It could move to the PC like the voice's did.
- **`look_at_board` fallback:** it asks the iPad only if the PC can't draw the view. The user
  hasn't decided whether to keep that fallback.
- **The voice's wording:** it sometimes still says "passing it along".
- **New tunnel address:** the quick tunnel's address changes about daily, and each new address
  means one full download on the iPad (the cache is per address).
- **Live page cards over plain http:** under WebKit, a live page card loaded over plain
  `http://127.0.0.1` can't load `/live-bridge.js` (a sandboxed frame doesn't match `'self'`).
  Over https (always, on the iPad) it's fine.

## 6. Rules from the user

- **Secrets:** the canvas link contains the access key (`?k=`). Never put it in files, commits,
  printed output or messages. Redact it in logs you show. `data/` is never committed. **This
  repo is public.**
- **The iPad is input and display only:** never ask the user to install, sign in to or set up
  anything on it. All networking is set up on the host. The one exception is updating the
  Canvas app in SideStore, and only with an IPA that `ios/fetch_build.py` has checked.
- **Voice:** Apple's recognizer and voices only. No speech models on the PC.
- **Prove fixes on the real stack,** with logged inputs and numbers. Mocked tests don't count.
- **Canvas fixes:** do them end to end and quickly. Repeated friction means redesign the system
  rather than patch it.
- **After every push:** bump `version` in `.claude-plugin/plugin.json`, push, then run
  `claude plugin marketplace update ddi-canvas` and `claude plugin update canvas@ddi-canvas`.
- **Voice prompt changes** (`talker.py`, `voice_mcp.py`) go live only after the host's server
  restarts.
- **Talking to the user:**
  - Answer where they wrote: canvas messages on the canvas (`say`), typed prompts in Claude Code.
  - Post short progress notes on the canvas during longer work.
  - Explain in real terms (tools, requests, files), not analogies.
- **No spend caps.** Don't add or mention any.

## 7. Where to measure

- **`data/client.log`, `boottime` lines:** each iPad startup. Every file is listed as cache,
  checked or downloaded, with times for ink and ready. The app always calls itself
  `CanvasApp/1.0` in its user agent.
- **`data/voice.log`:** one line per voice turn. `pics` holds how long the iPad took to send its
  ink and how long the PC took to draw; `first_ms` is when the voice started speaking.
- **Test board:** `smoke`. Copy real strokes there for realistic sizes, and never write to the
  user's boards.
