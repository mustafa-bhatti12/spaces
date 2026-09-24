# Design: Space

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

Color never decorates. Each hue means exactly one family of states.

## Type

- **Hanken Grotesk** (`--font-sans`): all UI text. Display is `clamp(2.5rem, 4.4vw, 4rem)`/600 with -0.035em tracking. Title is 1.625rem/600, body 0.9375rem, and dock legends 0.6875rem/600.
- **JetBrains Mono** (`--font-mono`): data only, meaning room names, timers, counts, identities, file names and sizes. Always tabular numbers.

## Components

- **Key** (`.key`): 44px high (58px in the dock, with the icon above a legend) and a 12px radius. It is flat with a 1px top edge highlight. Variants:
  - `-go`: green, primary
  - `-quiet`
  - `-danger`: outlined red that fills red on hover or focus
  - `-leave`
  - `-square`
  - `-wide`
- **Mic ring**: the signature detail. The mic key carries an inset 2px ring, green when live and red (on a red-tinted fill) when muted. It adds a 4px outer ring while the local participant is speaking. Pre-join draws the same ring on LiveKit's toggle.
- **Readout** (`Readout`/`ReadoutSegment`): a recessed screen strip, mono 0.8125rem. Segments are separated by 1px seams and it reports facts as plain text.
- **LED** (`Led`): an 8px dot in live, alert, warn or idle, with `pulse` for things in progress.
- **Dock**: the readout, then three key clusters separated by seams (media · talk · more), then Leave isolated on the right.
- **Menu**: a panel above its key, 14px radius, with `--pop` shadow. On phones it becomes a bottom sheet.
- **Face** (`.face`): a 16px-radius shell with the `--lift` shadow. Elevation comes from the shadow alone, never a border as well.
- **Side panel**: a floating 16px card, and only one is open at a time (people, settings, or LiveKit's Chat restyled to match).
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
