# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Call participants:** people in a video call, often not technical. A link lands them in a room; they type a name, check camera and mic, and talk. They reach the controls mid-conversation, so every control has to be found in a glance.
- **Operators:** whoever runs this deployment. They sign in to `/admin` to see live rooms, mute or remove people, start or stop recordings, play and download recordings, and check that services are healthy.

## Product Purpose

Space is self-hosted video calling on LiveKit: a media server, a token service (the only holder of the LiveKit credentials), audio recording and compression, and an operator control center. The `demo` app is the reference call UI. It stands in for how a consuming app (today, Petition Studio) embeds calls. It proves the stack end to end and doubles as the permanent operator console at `/admin`.

Success looks like this: joining takes one screen, a call feels as dependable as the tools people already use, and an operator can act on any room or recording in seconds.

## Positioning

Space is a neutral, unbranded video tool that any future app can embed through the token API. It is self-hosted, it records audio to disk the operator controls, and it offers operator moderation. It must not carry any consuming app's identity (no case IDs, client names, or Petition Studio branding).

## Operating Context

- Call UI: desktop browsers and phones; camera and mic permissions; unstable networks (a reconnect banner is shown).
- Deployed on Railway (`https://spaces-demo.up.railway.app`); media and API run at `https://spaces.hofmigration.com`.
- Admin: a single shared password, used occasionally by one or two operators.

## Capabilities and Constraints

- Built on Next.js 16 and React 19, with `@livekit/components-react` hooks and components for all call behavior. The look is our own; `@livekit/components-styles` may stay as a base, but its visual defaults are not the design.
- Call features:
  - pre-join with device preview
  - grid and focus layouts (auto-focus on screen share, click to pin)
  - chat
  - participants panel
  - device settings
  - background blur and virtual backgrounds
  - emoji reactions
  - raise hand
  - audio recording, with a REC badge showing who started it
  - invite link
  - fullscreen
  - reconnect banner
  - host (whoever started the room) can end the call for everyone; everyone confirms Leave
  - audio first on weak connections: video pauses before audio breaks up
  - relay over HTTPS (TURN on 443) for networks that block direct media
  - end screens: left, you ended the call, call ended (by the host or an admin), removed, duplicate tab, error
- Admin features:
  - password login
  - service health (LiveKit, recording worker, compressor, disk)
  - server metrics: CPU, memory, network, TLS expiry, deployed commit, per-service processes
  - live rooms and participants, with mute, remove, and close-room actions
  - start and stop recordings
  - a recordings list with play, download, and delete
- No AI agent for now.

## Brand Commitments

- Product name in UI: "Spaces", shown by the `Logo` SVG (dotted-box mark plus lowercase "spaces" wordmark, `demo/components/ui/Logo.tsx`); the admin is "Spaces Control Center".
- Neutral and generic by design; no HOF Migration or Petition Studio identity.

## Evidence on Hand

- Eight virtual-background photos in `demo/public/backgrounds/` (coast, forest, golden-hour, loft, ocean, studio, sunset, workspace).
- The Spaces logo. No customers, no testimonials, and no metrics. None of these may be invented.

## Product Principles

1. Talking comes first. The chrome disappears while people talk and shows up only when someone reaches for it.
2. One glance, one action. Related controls are grouped, and nothing is added "just in case".
3. Always show state. Mic, camera, recording, connection, and who is in the room are visible and never ambiguous.
4. Operators act with confidence. Destructive actions are clearly separated and confirmed.
5. Keep it generic. Nothing in the UI belongs to one consuming app.
