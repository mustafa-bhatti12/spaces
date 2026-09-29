# Design: Spaces

The built system lives in `demo/app/globals.css`, with primitives in `demo/components/ui/*`. Product context is in `PRODUCT.md`.

## World: the conference speakerphone

The design is modelled on the meeting-room speakerphone everyone knows: matte graphite plastic, one ring of light that tells you whether you're live, and a small status screen. Operators and participants read the interface by its lights and its readout, not by decoration.

- **Refuses:** the stock dark-grey meeting clone with a blue accent, a row of eleven equal buttons, glass, gradients, and emoji used as icons.
- **Scene:** people look at faces on video in ordinary room light. The dark graphite surround keeps faces the brightest thing on screen.

## Color: signal lights only (restrained)

| Token | Value | Role |
|---|---|---|
| `--ground` | `oklch(0.175 0.005 70)` | page |
| `--shell` / `--shell-up` | `0.215` / `0.24` | dock, panels, faces / menus |
| `--key` / `--key-hover` / `--key-press` | `0.27` / `0.305` / `0.345` | keys |
| `--screen` / `--screen-ink` | `oklch(0.135 0.005 70)` / `oklch(0.89 0.03 165)` | recessed readout, fields |
| `--ink` / `--ink-2` / `--ink-3` | `0.955` / `0.80` / `0.69` | text |
| `--live` | `oklch(0.79 0.17 152)` | mic live, speaking, primary "go" key, selection |
| `--alert` | `oklch(0.64 0.2 27)` | muted, recording, Leave, destructive |
| `--warn` | `oklch(0.83 0.15 80)` | raised hand, reconnecting, stale data |

Color never decorates. Each hue means exactly one family of states. The one exception is the logo's brand green (`#07D587`), used only in the logo's accent dot and the pre-join avatar placeholder.

## Type

Lean and readable: nothing in the UI is set below 12px (0.75rem) except mono badge caps, and nothing above 2.75rem.

- **Hanken Grotesk** (`--font-sans`): all UI text. Display is `clamp(2rem, 3.1vw, 2.75rem)`/600 with -0.035em tracking. Title is 1.375rem/600, body and lede 0.9375rem, keys 0.875rem/600, dock legends 0.75rem/600. Form fields stay at 1rem so iOS Safari doesn't zoom on focus.
- **JetBrains Mono** (`--font-mono`): data only, meaning room names, timers, counts, identities, file names and sizes. Always tabular numbers.

## Components

- **Logo** (`Logo` / `LogoMark` in `demo/components/ui/Logo.tsx`): the dotted-box mark plus the lowercase "spaces" wordmark, in `currentColor` apart from the green dot. `Wordmark` renders it at 22px high, with an optional suffix ("Control Center") after a seam.
- **Key** (`.key`): 38px high (50px in the dock, with a 19px icon above a legend; 44px icon-only below 1080px) and a 10px radius. Icons are 18px at a 1.6 stroke. It is flat with a 1px top edge highlight, and transitions use `--ease-out`. Variants:
  - `-go`: green, primary
  - `-quiet`
  - `-danger`: outlined red that fills red on hover or focus (a destructive action offered among safe ones)
  - `-destroy`: solid red, the confirming key of a destructive dialog
  - `-leave`
  - `-square`
  - `-wide`
- **Mic ring**: the signature detail. The mic key carries an inset 2px ring, green when live and red (on a red-tinted fill) when muted. It adds a 4px outer ring while the local participant is speaking. Pre-join draws the same ring on LiveKit's toggle.
- **Readout** (`Readout`/`ReadoutSegment`): a recessed screen strip, mono 0.8125rem. Segments are separated by 1px seams and it reports facts as plain text.
- **LED** (`Led`): an 8px dot in live, alert, warn or idle, with `pulse` for things in progress.
- **Dock**: the readout, then three key clusters separated by seams (media · talk · more), then Leave isolated on the right.
- **Menu**: a panel above its key, 14px radius, with `--pop` shadow. On phones it becomes a bottom sheet.
- **Face** (`.face`): a 14px-radius shell with the `--lift` shadow. Elevation comes from the shadow alone, never a border as well.
- **Side panel**: a floating 14px card, and only one is open at a time (people, settings, or LiveKit's Chat restyled to match).
- **Notification stack** (`ChatToasts`): 16px-radius translucent cards at the stage's bottom-right (up to 3 chat/join cards, newest nearest the dock): new chat messages (avatar, sender, mono time, 3-line preview; click opens chat) and "joined the call" (click opens People). The host's **join request** (`WaitingNotice`) leads the stack with an amber edge, the askers' avatars and Admit/Deny (Admit all/View all for several); it hides while People is open. **Alone card**: "You're the only one here" with a green Copy invite link key. System messages (invite copied, recording errors) keep the centered `.toast`.
- **Waiting room**: the host's `SwitchRow` on the pre-join (between name and Join) and at the top of People, which also lists who is waiting. Guests wait on an end-screen-style face with a pulsing amber "Waiting room" readout.
- **Row menu in People**: every row ends with a 30px `MoreVertical` key (revealed on row hover or focus, always shown on touch) opening a menu below it, right-aligned: "Pin for me" (hint "Only you") for everyone; hosts also get Pin for everyone, Mute mic, Make a host / Stop hosting, and a separated red Remove from call that asks "Remove {name}?" on the first click. Hosts carry the mono `HOST` chip, which never truncates (the name does). Errors replace the row's status line in red; pins, mutes and role changes are announced with the centered `.toast`.
- **Signal bars** (`SignalBars`, `demo/components/ui/SignalBars.tsx`): three rounded bars in a 16px box, lit bars in `currentColor`, unlit at 22%. Neutral `--ink-2` while the link is excellent (3) or good (2); amber `--warn` when poor (1); red `--alert-ink` when lost (0). Always shown in People; on tiles only when poor or lost, as a 28px chip next to the name plate. Replaces LiveKit's stock quality icon everywhere, including the focused stage tile.
- **Leave dialog**: a compact destructive confirmation (native `<dialog>`, portaled to `body`): red-tinted icon, title, one line, and right-aligned keys with Cancel focused. Guests confirm with a `-destroy` Leave; the host also gets `-destroy` End for everyone, with Leave demoted to a plain key.
- **Floating window** (`FloatingWindow.tsx`, Document Picture-in-Picture, opens 400×225 = 16:9, resizable): everyone else's face edge to edge (square corners, no focus toggle), in a 2px-gapped grid — one full, two side by side, three with the loudest-recent spanning the top row, four as 2×2, and a `+N` chip bottom right for the rest; a pin or screen share takes the window alone. Floating over it:
  - top left, always: a dark pill status chip (mono 0.75rem) with people count, `REC` + pulsing LED + timer while recording, and a red "Muted" segment while your mic is off;
  - top right: your self-view (26% wide, 76–168px, 8px radius, mirrored like your camera) while your camera is on and you aren't one of the faces; hidden below 300px wide;
  - bottom centre: a small copy of the dock's key pill (`#1e1f20`, circular 40px keys): mic (green tint when live, 3px green ring while you speak, solid red when muted), camera (solid red when off), and the red Leave pill, which grows to "Leave call" with a white inset ring on the first click (Escape or 4 s cancels).
  The pill fades out 2.5 s after the pointer stops (or when it leaves the window) and back in on any movement or keyboard focus; the name plate rides 54px up while it's shown. A new face on the stage fades in.
- **Phone self-view** (`ConferenceLayout`, at most 560px wide): on a phone your own camera leaves the grid and becomes a 27vw (max 132px) 3:4 thumbnail with a 12px radius above the dock's right corner, so a one-to-one call gives the other person the whole screen. It carries the name plate only (no signal bars, hand badge or focus key) and the whole thumbnail is the control: tap it and you take the stage (the stock focus layout, its shrink key puts you back).
- **Transcript panel** (`/admin` recordings): opens under its row as a recessed `--screen` card. The head reads "duration · N speakers · languages" with `.txt` and close keys. Each line is a mono time, the speaker in `--screen-ink`, and the text; it scrolls past 420px and stacks on phones. The Transcript column shows the state: a Transcript key when ready, a pulsing amber LED with "Transcribing…", red "Failed" with Retry, "Queued" with Transcribe now, or "Off" without a Soniox key.
- **Destructive actions**: always separated from safe ones by a `.danger-gap` (16px), outlined until hover or focus, and confirmed.

## Motion

Motion uses exponential ease-out (`--ease-out`), for menus rising 6px, panels sliding in 12px, toasts, the hand badge popping up, and reactions floating. Notifications are CSS transitions with `@starting-style` (not keyframes, so bursts retarget): they enter 24px from the right in 300ms (from the top on phones) and leave the same way in 180ms. A new join request fires one amber ring from its icon, and each asker's avatar scales in from 0.9. New video tiles fade in from scale 0.96. The LED pulses only for recording, live rooms, the waiting room, a weak connection and a transcript in progress. Under reduced motion notifications and tiles only fade, and everything else is instant; reactions fade instead of flying.

## Responsive

| Width | Change |
|---|---|
| ≤1240px | the recorder's name leaves the readout |
| ≤1080px | legends are hidden and keys are 50px |
| ≤900px | layouts go to one column and the readout floats over the stage |
| ≤760px | side panels cover the stage |
| ≤560px | 46px keys; device chevrons and Share are hidden (device switching is in Settings); menus become sheets; notifications become a top banner (2 chat/join cards at most, newest on top, 2-line preview; the join request and alone card stay on top) |
