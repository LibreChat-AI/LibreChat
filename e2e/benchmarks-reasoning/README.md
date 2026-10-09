# Reasoning-Stream Perf Benchmark (react-scan)

Verifies that streaming one long, **unsplit** reasoning block (plus long markdown
text) through the real mock-model agents pipeline stays render-bounded — i.e.
the legacy content-part splitting (`SplitStreamHandler` / `blockThreshold`,
removed in #10533) is not needed for rendering performance.

What it measures, via [react-scan](https://github.com/aidenybai/react-scan)
injected into the page:

- Per-component render counts and render time while a ~18k-char `<think>` block
  and ~6k-char markdown reply stream token by token.
- That the whole reasoning section lands in **one** think part (a single
  "Thoughts" toggle) — no re-splitting anywhere in the pipeline.
- rAF coalescing: the think box re-renders far fewer times than there are
  streamed chunks.
- Markdown block memoization: `MarkdownBlock` renders stay ~O(tokens + blocks),
  not O(tokens × blocks).
- Main-thread health: long-task totals bounded relative to stream wall time.
- Typing latency after the long transcript: transcript components must not
  re-render per keystroke.

## Run

react-scan is not a repo dependency; provide the bundle path. The recorded
baselines and thresholds were measured with react-scan 0.5.7 — instrumentation
overhead and `onRender` semantics are version-dependent, so keep it pinned:

```bash
npm i --no-save react-scan@0.5.7
npx playwright test --config=e2e/playwright.config.reasoning-perf.ts
```

or point `REACT_SCAN_PATH` at an existing
`react-scan@0.5.7/dist/auto.global.js`.

Requires a built client (`client/dist`) like the other mock e2e configs.
