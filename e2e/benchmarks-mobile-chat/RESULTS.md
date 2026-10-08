# Mobile Chat Performance Baseline

Captured September 2, 2026 from LibreChat `519e64769` on an Apple M4 Max with
macOS 26.6, Node.js 24.16.0, Playwright 1.62.1, and Chromium at the iPhone 13
descriptor's `390x664` viewport on a `390x844` screen. The production client
was used.

The stress conversation contained 150 user/assistant turns (300 rows) with
prose, lists, code blocks, and tables. The continuation phase streamed three
additional rich Markdown replies. `busy` is Chromium main-thread task time
divided by elapsed wall time; it is a useful comparison proxy, not device CPU
utilization.

## Raw browser measurements

| Phase                   |      Wall | Main-thread busy |      Task |   Script |  Style | Long tasks (total/worst) | Heap at end | DOM nodes |
| ----------------------- | --------: | ---------------: | --------: | -------: | -----: | -----------------------: | ----------: | --------: |
| Empty chat idle         |  3,007 ms |            15.9% |    479 ms |   273 ms |  64 ms |               102/102 ms |     52.6 MB |     2,063 |
| Load 300 rows           |  2,909 ms |            84.4% |  2,455 ms | 1,717 ms | 119 ms |               347/250 ms |    271.2 MB |   121,371 |
| Long chat idle          |  3,030 ms |            14.5% |    439 ms |     5 ms | 132 ms |                   0/0 ms |    349.5 MB |   123,427 |
| Four full scroll cycles |  3,787 ms |            90.9% |  3,441 ms | 1,107 ms | 343 ms |                   0/0 ms |    348.4 MB |   123,587 |
| Three continuations     | 11,182 ms |            95.2% | 10,646 ms | 4,208 ms | 872 ms |             2,791/325 ms |    511.6 MB |   126,234 |
| Typing after stress     |  1,357 ms |            71.1% |    965 ms |   206 ms | 145 ms |                   0/0 ms |    541.7 MB |   127,013 |

Heap figures are point-in-time values without forced garbage collection, so
they do not establish a memory leak.

## React Scan diagnostic

React Scan observed 44,521 render records while loading, 2,852 while scrolling,
201,013 during the three streamed continuations, and 1,334 while typing. The
settled long conversation produced only 26 render records during its
three-second idle phase. This points away from a continuous React rerender loop
as the source of settled-idle work, but shows a very large amount of React work
during streaming.

React Scan materially perturbed the workload. During continuation, Chromium
script time increased from 4,208 ms to 12,332 ms and task time increased from
10,646 ms to 14,991 ms. Its instrumented production-build timings were reported
as zero and many component names were minified. Therefore the raw run is the
performance baseline; React Scan is useful here only for comparative render
counts and for narrowing a follow-up development-build profile.

## Interpretation

This run supports the report that long LibreChat conversations can sustain high
frontend work while loading, scrolling, and streaming. It does not prove that
ordinary LibreChat use consumes more energy than other apps, and it cannot
measure iPhone thermals or Mobile Safari behavior.

The largest scaling signal is the document size: after progressive mounting
settles, all 300 rows remain mounted at roughly 120,000 DOM nodes. The current
progressive-row strategy optimizes the first commit but deliberately converges
to the complete DOM. A real-device Safari energy trace and a controlled A/B
against a bounded/virtualized message DOM are the next tests needed to connect
this browser result to phone heating.
