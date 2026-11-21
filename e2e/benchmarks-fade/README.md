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

- **`speech.perf.spec.ts`**: the cost of the read-aloud control. Every assistant row carries a
  hidden `<audio>` element for it, which should load nothing until its button is pressed. The
  spec counts the media errors and media requests those elements make while the thread mounts
  and across two short runs, and traces the main thread for each. Anything above zero errors
  and one request (the composer's silent clip) is a row loading something it was not asked to.

- **`sidebar.perf.spec.ts`**: the cost of opening and closing the sidebar beside the thread.
  The sidebar slides by changing its width, so the chat pane changes width on every frame of
  the slide; each direction is traced on its own. `ms/frame` and the longest task say whether
  the slide can hold a frame rate. `FADE_PERF_PROFILE=1` adds the script's self time and
  `FADE_PERF_WHY=1` the components that render for each toggle.
- **`rail.perf.spec.ts`**: the cost of opening and closing the session rail beside the thread,
  with the sidebar's toggle traced in the same run as the yardstick. The rail does not slide, so
  the thread changes width once. `FADE_PERF_WHY=1` counts what renders for each toggle, beside an
  idle second and the sidebar's: no message row should, at any thread length.
  A second test grows the last reply for three seconds with the rail closed and then open and
  listing running work, and prints the page's compositor layer count beside each: a row that
  animates is a layer, and every frame of the thread pays for the layers on the page. For the
  cost per kind of stream event, run the replay with `FADE_PERF_RAIL=closed` and then `open`:
  the conversation becomes an agent's with running tools, finished tools and subagents staged
  for the rail (`rail.ts`), and the two runs differ only in whether the rail is showing.
- **`scroll.perf.spec.ts`**: the cost of reading back through the thread, a page at a time
  from the latest turn towards the first and back. Rows far from the viewport are skipped by
  the browser and laid out again as a scroll brings them near, so this is where that work
  shows up if it ever costs more than it saves.

- **`open.perf.spec.ts`**: the cost of opening the thread: by reloading it, by switching to
  it from the sidebar, and by switching to it while it has a reply in flight, which is the
  thread a reader most often comes back to. A long thread mounts in steps, so the trace
  reports how long the main thread was busy until every row was in, how many tasks ran over
  50 ms and the longest of them: the freeze a reader feels is those tasks, not the total. The
  switch also prints the row count at each frame; a single step from a few rows to all of
  them is a thread mounted in one commit. `FADE_PERF_PROFILE=1` with `FADE_PERF_DUMP` writes
  a trace and a CPU profile of one more switch on the same clock, so the profile's samples
  can be read task by task. Run it with `FADE_PERF_LIGHT=1`: a thread mounting sets thousands
  of timers, and the call stack the full trace records for each one is a third of what it
  then measures.

- **`restyle.perf.spec.ts`**: the cost of one small change in every row at once, which is
  what a run starting or ending is. It flips a class, flips `disabled` and mounts a button on
  each row by hand and times the style and layout pass that follows. With a stylesheet whose
  `:has()` rules name their subjects these are a few milliseconds per hundred rows; a single
  rule that does not multiplies them by ten.

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
| `FADE_PERF_TTS`          | `0` turns read-aloud off, removing the per-row `<audio>` elements.   |
| `FADE_PERF_PROMPT`       | The fake model's scripted reply for the live run.                    |
| `FADE_PERF_CSS`          | A stylesheet laid over the shipped one, to try a remedy.             |
| `FADE_PERF_SKIP_LIVE`    | `1` stops the frame spec after the idle and label traces.            |
| `FADE_PERF_PROFILE`      | `1` samples the page's JavaScript: a second live run, or the replay. |
| `FADE_PERF_DUMP`         | A directory that receives raw traces, profiles and replay windows.   |
| `FADE_PERF_LIGHT`        | `1` traces the timeline without call stacks, which cost per timer.   |
| `FADE_PERF_ROUNDS`       | How many times the open spec repeats each measurement; 4 by default. |
| `FADE_PERF_STORAGE`      | Local settings to open the chat with, as `key=value,key=value`.      |
| `FADE_PERF_CATEGORIES`   | More trace categories for a dump, comma-separated.                   |
| `FADE_PERF_REPLAY_INDEX` | Which message to replay (position in the flattened export).          |
| `FADE_PERF_REPLAY_PARTS` | Replays only the first N content parts.                              |
| `FADE_PERF_GAP_MS`       | Pause after each replayed frame; 150 by default.                     |
| `FADE_PERF_ANIMATIONS`   | `1` lists what is animating during the replay, and which properties. |
| `FADE_PERF_WHY`          | `1` counts component renders across the replay, with their causes.   |
| `FADE_PERF_RAIL`         | `closed` or `open`: stages background work for the session rail.     |
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

To compare with and without skipped rows on one build, lay this over the page with
`FADE_PERF_CSS`; the rows are still marked, but every one is laid out and painted:

```css
.message-render[data-offscreen] {
  content-visibility: visible !important;
}
```

Role locators are kept out of the measured windows: Playwright computes
accessible names across the whole transcript on each poll, which a trace
records as the page's own work.
