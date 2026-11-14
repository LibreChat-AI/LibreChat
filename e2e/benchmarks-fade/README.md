# Live-run frame and event cost

Measures what a live run costs the browser's main thread inside a long, real
transcript, from a Chromium trace of the built client:

- **`fade-frames.perf.spec.ts`**: the cost of a frame. Traces the open chat
  idle, then with one sweeping label (`Shimmer`) on screen, then through a
  short live run. An animation that stays on the compositor costs the main
  thread nothing; one that repaints shows up as hundreds of frames of `Paint`,
  and that paint grows with the transcript around the label.
- **`replay.perf.spec.ts`**: the cost of each kind of stream event. Takes one
  assistant message from the chat, streams it back in at the tail of the same
  chat a frame at a time, and reports main-thread time per window by event
  kind: a tool call starting, its arguments, its result, a label filling, a
  reasoning or text delta, the final frame. `idle` windows carry no event and
  show what is left over from the events before them. Part way through, the
  replay holds the run still for three seconds and traces that on its own: with
  no event arriving, whatever the main thread does there it does for the run's
  animations.

The transcript is yours. Nothing synthetic stands in for it, because the point
is a conversation of the size and shape a reader actually has: export one from
the chat's Export action as JSON and pass its path.

## Run

Requires a built client (`client/dist`) like the other mock e2e configs.

```bash
npm run frontend
FADE_PERF_CHATS=/path/to/export.json \
  npx playwright test --config=e2e/playwright.config.fade-perf.ts
```

`FADE_PERF_CHATS` takes several paths, comma-separated; each gets its own run.
To compare two builds, run the same command on each and read the tables side
by side.

| Variable                 | Effect                                                               |
| ------------------------ | -------------------------------------------------------------------- |
| `FADE_PERF_CPU`          | Slows the renderer by this factor, as DevTools CPU throttling does.  |
| `FADE_PERF_THEME`        | The color theme to open the chat in, such as `dark`.                 |
| `FADE_PERF_PROMPT`       | The fake model's scripted reply for the live run.                    |
| `FADE_PERF_CSS`          | A stylesheet laid over the shipped one, to try a remedy.             |
| `FADE_PERF_SKIP_LIVE`    | `1` stops the frame spec after the idle and label traces.            |
| `FADE_PERF_PROFILE`      | `1` samples the page's JavaScript: a second live run, or the replay. |
| `FADE_PERF_DUMP`         | A directory that receives raw traces, profiles and replay windows.   |
| `FADE_PERF_CATEGORIES`   | More trace categories for a dump, comma-separated.                   |
| `FADE_PERF_REPLAY_INDEX` | Which message to replay (position in the flattened export).          |
| `FADE_PERF_REPLAY_PARTS` | Replays only the first N content parts.                              |
| `FADE_PERF_GAP_MS`       | Pause after each replayed frame; 150 by default.                     |
| `FADE_PERF_ANIMATIONS`   | `1` lists what is animating during the replay, and which properties. |
| `FADE_PERF_WHY`          | `1` counts component renders across the replay, with their causes.   |
| `FADE_PERF_WHY_LIMIT`    | How many components that count lists; 80 by default.                 |

## Reading the output

`busy` is main-thread time over wall time; `frames` counts the frames the main
thread produced. A page at rest produces a handful. A label whose animation
runs on the main thread produces one per display refresh.

In the replay tables every column is the median over that kind's windows, in
milliseconds of main-thread time per window, split by self time: a layout
forced from script counts as layout. `worst` is the longest single task seen
for the kind. Subtract the `idle` row to get what an event adds.

The replay also times the turn's two ends as windows of their own: `send` is
the keypress that publishes the turn, `created` the frame that confirms it, and
`final` the frame that closes the run. Each of those changes every row's
toolbar, so they are where a long thread shows its long tasks.

`FADE_PERF_WHY=1` swaps the trace for a render count: for the send, the events
and the final frame, each component that rendered, how many times, and why (a
prop that changed identity, a state or store hook of its own, query data it
selects, a context it reads, or only its parent). It runs on the production
bundle and names components by the source map when the build wrote one, else
by where the function sits in its chunk. A component that renders once per
event with nothing to show for it is the thing to look for.

When a window shows a long layout or style pass with almost nothing dirty, dump
the trace with `FADE_PERF_CATEGORIES=disabled-by-default-devtools.timeline.invalidationTracking`
and read the `StyleInvalidatorInvalidationTracking` events before it: they name
the nodes whose subtrees were invalidated and the selector feature that did it.
That is how a `disabled` flip on one button per row turned out to re-style every
row of the thread, through the stylesheet's `:has(:disabled)` rules.

Role locators are kept out of the measured windows: Playwright computes
accessible names across the whole transcript on each poll, which a trace
records as the page's own work.
