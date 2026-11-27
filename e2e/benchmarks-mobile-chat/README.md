# Mobile Chat Performance Benchmark

Measures long-conversation behavior with Playwright's iPhone 13 descriptor: a
`390x664` browser viewport on a `390x844` screen. It uses a local production
build and the mock-model pipeline; no provider credentials or external model
calls are used.

The benchmark seeds 150 user/assistant turns (300 rendered message rows), then
captures six phases:

- sitting idle on an empty chat as a control;
- loading and progressively mounting the long transcript;
- sitting idle for three seconds after the transcript settles;
- repeated full-history scrolling;
- three streamed continuation turns with long Markdown responses;
- typing after the transcript grows to 306 rows.

Each scenario records Chromium `Performance` domain counters (main-thread task,
script, layout and style time), long tasks, heap size, and DOM node count. It
runs twice: first without react-scan for lower-overhead browser measurements,
then with react-scan to attribute render counts and duration to components.

This is a desktop-hosted Chromium measurement at an iPhone viewport, not a
physical-device battery or thermal measurement. Use it to reproduce and compare
frontend changes locally; confirm energy impact separately on a real iPhone.

## Run

Extract the pinned instrumentation bundle outside the repository so npm cannot
re-resolve LibreChat's dependencies, prepare the production client, then run
the benchmark:

```bash
mkdir -p /tmp/librechat-react-scan
npm pack react-scan@0.5.7 --pack-destination /tmp/librechat-react-scan
tar -xzf /tmp/librechat-react-scan/react-scan-0.5.7.tgz -C /tmp/librechat-react-scan
npm run e2e:prepare
REACT_SCAN_PATH=/tmp/librechat-react-scan/package/dist/auto.global.js \
  npx playwright test --config=e2e/playwright.config.mobile-chat-perf.ts
```

JSON snapshots are attached to the Playwright results under
`e2e/benchmarks/.test-results/mobile-chat`.

## Deterministic regression guards

The normal mock E2E suite includes `idle-animations.spec.ts`. It renders six settled
messages, including three code blocks, in desktop and narrow layouts and asserts
that the transcript has **no running infinite animations**. The check uses the
browser's animation API, so it catches opacity-hidden spinners and other perpetual
CSS animations. It explicitly enables motion, waits for every code control to
mount, permits finite entrance transitions, and reports the offending animation
and element when it fails. It needs neither a large transcript nor a CPU/time
threshold to catch work that would multiply across a long chat.

After preparing the production client, run it with:

```bash
npx playwright test --config=e2e/playwright.config.mock.ts idle-animations.spec.ts
```

The component tests cover the complementary invariants: `RunCode.test.tsx`
checks that the spinner exists only during execution, including success, failure,
and retry, with fake timers and controlled HTTP completion. `QuoteButton.test.tsx`
uses a React Profiler to assert zero commits for selection and positioning events.

Keep the browser timing measurements above as diagnostic evidence rather than a
single-run merge gate. When a benchmark identifies a regression, add a focused
invariant test at the cause—such as no idle animations, no unrelated renders, or
bounded request counts—where possible. Timing and memory totals vary with the
runner, garbage collection, and browser version; these structural checks do not
require those numbers to stay below an arbitrary threshold.
