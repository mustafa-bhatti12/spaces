# Changelog

What shipped, newest first. One line per user- or operator-visible change; commit hashes point at
the detail. Agents: add a line here with every change that ships (see `AGENTS.md`).

## 2026-09-29

- **No more hall of mirrors when you share your screen.** The Spaces tab is kept out of Chrome's picker, your own share is no longer played back to you (a green "You're sharing your screen" notice with a Stop key takes its place, like Meet), and you can switch to another tab or window mid-share without stopping first.
- **The floating window shows everyone,** not just one person: up to four faces in a grid (`+N` when there are more), or the pinned person alone; you stay the corner self-view.
- **Phones show the other person full screen.** Your own camera becomes a thumbnail in the corner instead of taking half the grid; tap it and you take the stage, tap the shrink key to go back.
- **Fixed:** pinning someone who then left the call left their frozen tile on the stage for good.
- **New addresses:** the call app and `/admin` are at `https://spaces.hof-global.com` (Railway custom domain; the old Railway URL still works), the token API and call signaling at `https://api.spaces.hof-global.com` (`/token` now returns `wss://api.spaces.hof-global.com`), and TURN at `turn.hof-global.com`. The old `spaces.hofmigration.com` and `turn.hofmigration.com` are retired and no longer answer.
- **Floating window (Picture-in-Picture), like Meet's:** in Chrome and Edge on desktop, switching to another tab during a call opens a small always-on-top window with the other faces edge to edge, your self-view, a status chip (people, `REC` timer, "Muted"), and a pill of mic, camera and Leave keys that fades away while you don't touch the window (Leave asks once more). Coming back to the tab closes it. More → Floating window opens or closes it by hand. Not offered in other browsers, on phones, or inside `/embed`.
- **`/admin` recordings: search and pages.** A search box filters recordings by room or file name, and the list shows 20 per page (newest first) with Newer / Older.
- **`/admin` Settings tab:** Overview and Settings pill tabs. Settings changes transcription (on/off, language hints, terms, translate-to) and recording (bitrate, record every call) live with no restart, overriding `.env` until "Reset to .env"; shows the droplet's and the call app's deployment values read-only (secrets only as set / not set); and has a Restart Spaces key that token-service refuses while anyone is in a call or a recording runs. The admin password stays a Railway variable.
- **Transcripts can include an English translation:** with `TRANSCRIPTION_TRANSLATE_TO=en` (now on), each line spoken in another language (e.g. Urdu) carries its English translation, in the transcript JSON, `/admin`'s text view and download, and `/recording/transcripts`.
- **Consumers can download call audio:** `GET /recording/file/<file>` (consumer secret) streams a finished recording listed by `/recording/transcripts`.
- **Consumers can record a call automatically:** `POST /token` takes `record: true`, and that room's recording then starts when the first person joins, like `RECORD_ALL_CALLS=1` for just that call. Other calls still record only when someone presses Record.
- **Host moderation:** each person's menu in People lets a host pin them for everyone (everyone's stage follows; anyone can still pin someone else for themselves), mute their mic (they're told, and can unmute themselves), or remove them (two-step confirm; they can't rejoin that call). Hosts can't remove another host without stopping them hosting first.
- **Pin for me:** anyone can pin a person on their own screen from the People menu, as well as from a tile.
- **New connection indicator:** three clean bars instead of LiveKit's stock icon: neutral when the link is fine, amber when poor, red when lost. People always shows it; tiles show it only when someone's connection is poor or lost. The pinned stage tile now uses the same name plate as the grid, and the `HOST` chip no longer gets cut off.
- **Noise cancellation is RNNoise:** the Settings switch (off by default) now runs RNNoise on your mic in the browser: about 18 dB less background noise in testing, speech unchanged, ~20 ms added delay, a few % of one core. It no longer touches Chrome's Voice isolation, which stays off. Echo cancellation, noise suppression and auto gain are always on.

## 2026-09-28

- **Calls are no longer recorded by default:** a call is recorded only when someone presses Record (or from `/admin`). `RECORD_ALL_CALLS=1` brings back recording every call. Recordings are still transcribed.
- **Dropped DeepFilterNet3:** the Settings noise-cancellation switch no longer runs a wasm filter on the mic (it added delay and chewed speech). It only turns on Chrome's Voice isolation. Echo cancellation and ordinary noise suppression stay on either way.
- **Voice isolation is off by default:** Chrome's Voice isolation (LiveKit turns it on) stays off until someone switches on Noise cancellation in Settings. Echo cancellation and ordinary noise suppression stay on.
- **Noise cancellation is off by default:** the Settings switch still turns it on, and the choice is remembered per browser.
- **Noise cancellation:** a Settings switch (Microphone) runs DeepFilterNet3 on your mic in the browser, so others and the recording hear your voice without the background noise (about 30 dB less noise in testing). Remembered per browser. No server cost.
- **Embed mode:** consumer apps can iframe a call at `/embed` with a join token in the URL fragment (verified by token-service `POST /embed/session`), framed only by `EMBED_ALLOWED_ORIGINS`, and talk to it over the `spaces-embed/1` postMessage bridge (join/leave/recording/screenshare events, `app.*` data messages). Embedded calls hide invite links and the waiting room; the token decides who hosts.
- **Smaller status pill on phones:** the room name, people count and REC readout at the top of a call is 24 px tall with 11 px text (was 32 px and 13 px).
- **Video no longer pauses on a weak connection:** your camera no longer pauses itself, and the server no longer pauses video for a viewer on a weak link. The weak-connection readout stays.
- **Every call is recorded:** the recording starts by itself when the first person joins; anyone can still stop it, and it then stays off for that call. `RECORD_ALL_CALLS=0` turns this off.
- **Transcripts (Soniox):** every finished recording is transcribed with speakers separated ("Speaker 1", "Speaker 2"), times and languages. In `/admin`, each recording has a Transcript key (read it under the row, download it as `.txt`, retry a failed one); consumers get `GET /recording/transcripts?room=`. Recordings from before this were transcribed too. `TRANSCRIPTION_LANGUAGE_HINTS` and `TRANSCRIPTION_TERMS` tune accuracy.
- **More than one host:** a host can make anyone in the call a host too (the shield key on their row in People, shown on hover), or stop them hosting. It takes effect at once, with a "You're a host now" / "You're no longer a host" notice; every host can run the waiting room and end the call for everyone. Nobody can change their own role, so a call always keeps a host.
- **Your name is filled in again:** the pre-join remembers the name from your last call. Join no longer greys out while the field looks empty to the page but shows a name (browser autofill or restored form state left a filled field with a dead button); pressing Join with no name points at the field instead.
- **Waiting room:** the host can switch it on while entering their name, or any time from People. People then ask to join and wait on an "Asking to join…" screen; the host gets a join-request notification (Admit / Deny, or Admit all for several) and a list in People. Turning it off lets everyone waiting in. A request nobody answers ends after 10 minutes, like Google Meet. token-service enforces it, so a guest can't get a token around it.
- **More call states:** "You're the only one here" with a copy-invite key while you're alone; "Alice joined" notifications; a "Weak connection" readout in the dock while your link is poor; and the end screen shows how long you were in the call and how many people joined.
- **Notification motion:** notifications slide in from their edge and leave the same way, faster than they arrived. Each new join request pulses once and adds the asker's avatar, and new video tiles fade in instead of popping. Under reduced motion they only fade.
- **Quiet browser console:** the deployed call and admin pages no longer log to the browser console (LiveKit connection states and WebRTC stats, MediaPipe GL info); logging stays on the server. `localStorage.setItem('spaces-debug', '1')` brings it back. Fixed the mirror setting sometimes not reaching other participants: it was sent before the join finished and timed out (the "Request to update local metadata timed out" error); raise hand failures no longer throw either.
- **Lighter background effects:** the settings tiles now load 320 px WebP thumbnails (about 60 KB for all nine, was 2.6 MB of full-size JPEGs), and the backgrounds themselves are WebP (1.4 MB total, was 2.6 MB). MediaPipe's wasm and a pinned segmenter model are served from the demo's own origin instead of jsdelivr and an unpinned googleapis `latest`, so effects also work on networks that block those CDNs. The call page stops polling recording status while the tab is hidden and refreshes when it's shown again.
- **Recording uses less CPU:** egress now writes recordings straight at 24 kbps Opus, so the separate ffmpeg compressor is gone. It used to pin one of the droplet's two cores for about 86 s per recorded hour after every call. Files are the same size as before (about 11 MB an hour). The recording worker is pinned to egress v1.14.1, and the admin console no longer lists a Compressor.
- **Escape closes side panels:** Escape closes the open chat, people or settings panel, even while typing a message. An open dock menu or the Leave dialog takes the key first, and focus returns to the panel's dock key.
- **Chat message notifications:** new messages while chat is closed now show as message cards (avatar, sender, time, up to three lines of text) stacked bottom-right of the call, or as a banner across the top on phones. Click or tap one to open the chat, × to dismiss; hovering holds them.

## 2026-09-25

- **Unified dock device pills & telemetry disabled:** dock mic and camera capsules now show consistent corner curvature, inset separator lines, and unified alert styling when muted or off; Next.js anonymous telemetry disabled across dev and build pipelines.
- **Faster camera preview on the join screen:** the camera now opens once instead of up to five times (LiveKit's pre-join reopened it on re-renders, on a first-visit placeholder id, and when its device menus mounted), so your video appears about a second or more sooner, most on a first visit.
- **TURN relay over HTTPS:** callers on networks that only allow port 443 now get audio and video, relayed by LiveKit's built-in TURN at `turn.hofmigration.com` behind Caddy's `layer4` route. Verified with a relay-only Chrome call. (`c296561`, `e98b931`)
- **Virtual backgrounds:** eight 1080p photos (coast, forest, golden hour, loft, ocean, studio, sunset, workspace); reworked display-name entry on the phone pre-join screen. (`9d0df1d`)
- **Reboot-safe droplet:** the stack runs as `spaces.service`, starts on boot, and restarts itself if LiveKit, token-service, the compressor or Redis dies; the recording worker restarts on crash. (`fb6b5ff`, `ba131ae`)
- **Admin server metrics:** a Server section with CPU, memory, network, TLS expiry, deployed commit and a per-service process table. Polling pauses in a background tab, and the endpoint no longer calls `docker stats`, so an open admin tab costs about 0.4% of one core. (`f9d7662`, `e3df0af`, `d5f8331`)
- **Ubuntu updates moved to the quiet hours** (22:00 UTC, 03:00 PKT); they had pushed CPU to 60% at 11:00 PKT. (`7c028fa`)
- **Audio first on weak connections:** the server pauses video for a viewer who can't carry it (`allow_pause`); the camera sends at lower priority (540p max) and pauses itself after 10 s of poor connection. (`51b1245`)
- **Leave confirmation for everyone;** the host (whoever started the room) can also end the call for everyone. Compact destructive dialog; leaner type and control scale. (`c5e35b9`, `e4194aa`, `cac1689`)

## 2026-09-24

- **New UI** ("conference speakerphone" design): grouped dock with a status readout, lit mic ring, React and More menus, settings as a side panel, new lobby, pre-join, end screens and admin console. `DESIGN.md` records the system. (`16431a4`, `8fd82f9`)
- **Recording fixed on the droplet:** recordings failed on save (egress couldn't write the root-owned `egress/raw`), and stray `EG_*.json` manifests showed up as unplayable recordings. (`16431a4`, `1e3706d`)
- **Demo rebuilt on Next.js 16 + LiveKit React components**, replacing the static test-call page; the admin control center moved into it at `/admin`. (`5b38a18`, `fc7035a`, `eb9720f`)
- **Public deployment:** DigitalOcean droplet behind Caddy at `spaces.hofmigration.com`, `demo` on Railway, admin control center with its own secret and password, firewall locked down. (`326b5e4`, `ba50c7d`, `2927663`)

## 2026-08-31

- Recording pipeline: records who started a recording, stops it automatically when the room ends, and starts the egress worker with the stack. (`cef9f00`)
- Codespaces and VPS support: `start-all.sh` installs missing dependencies, egress webhooks are signed. (`e36126f`, `d847b7b`, `249d2e0`)

## 2026-08-28

- First working stack: `token-service` (the only holder of LiveKit credentials), a test-call page, device-based identity with duplicate-tab eviction, TLS for signaling (Firefox), and Meet-style layouts. (`27f5cf3` … `05d7b45`)
