# Changelog

What shipped, newest first. One line per user- or operator-visible change; commit hashes point at
the detail. Agents: add a line here with every change that ships (see `AGENTS.md`).

## 2026-09-25

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
