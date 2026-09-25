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
- **Leave dialog**: a compact destructive confirmation (native `<dialog>`, portaled to `body`): red-tinted icon, title, one line, and right-aligned keys with Cancel focused. Guests confirm with a `-destroy` Leave; the host also gets `-destroy` End for everyone, with Leave demoted to a plain key.
- **Destructive actions**: always separated from safe ones by a `.danger-gap` (16px), outlined until hover or focus, and confirmed.

## Motion

Motion uses exponential ease-out (`--ease-out`), for menus rising 6px, panels sliding in 12px, toasts, the hand badge popping up, and reactions floating. The LED pulses only for recording and live rooms. Under reduced motion everything is instant; reactions fade instead of flying.

## Responsive

| Width | Change |
|---|---|
| ≤1240px | the recorder's name leaves the readout |
| ≤1080px | legends are hidden and keys are 50px |
| ≤900px | layouts go to one column and the readout floats over the stage |
| ≤760px | side panels cover the stage |
| ≤560px | 46px keys; device chevrons and Share are hidden (device switching is in Settings); menus become sheets |
