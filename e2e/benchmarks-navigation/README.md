# Conversation-Navigation Perf Benchmark (react-scan)

Guards the app's most-used interaction: picking another conversation from the
sidebar. The regression it exists to catch is a **stale switch** — the URL
becomes `/c/<next>` while the *previous* conversation is still what's painted.

Two 30-turn (60-row) conversations are seeded straight into Mongo, then the
spec switches between them twice: once cold (target not cached) and once warm
(both message caches populated — the case users hit constantly when bouncing
between two open chats).

## What it measures

An in-page sampler records, once per animation frame, the route the browser is
showing and which conversation's rows are mounted. From that:

- **`staleFrames` / `staleAfterUrlMs`** — frames where the URL already named the
  next conversation while the previous transcript was still on screen. This is
  the headline metric and the one the assertions are built around. Frames
  showing *neither* transcript (the cold switch's spinner) are not stale; only
  the wrong conversation is.
- **`clickToUrlMs`** — click to route change. Catches navigation being gated
  behind a server round trip again.
- **`clickToPaintMs`** — click to the next transcript painted.

Plus, via [react-scan](https://github.com/aidenybai/react-scan): total component
renders and main-thread long tasks across each switch.

## Why this is a real hazard

`RouterProvider` commits location updates inside `React.startTransition` by
default in react-router v7. A transition keeps the OUTGOING tree painted until
the incoming one has finished rendering — so any work that makes the incoming
conversation slow to render is paid as time the user spends looking at the
wrong conversation, under the right URL. `App.jsx` opts out at the provider,
so putting the app back on the transition lane is one of the regressions this
benchmark catches.

## Run

Requires a built client (`client/dist`) like the other mock e2e configs.
react-scan is not a repo dependency; provide the bundle path. Baselines were
measured with react-scan 0.5.7 — instrumentation overhead and `onRender`
semantics are version-dependent, so keep it pinned:

```bash
npm i --no-save react-scan@0.5.7
npm run e2e:benchmark:navigation
```

or point `REACT_SCAN_PATH` at an existing
`react-scan@0.5.7/dist/auto.global.js`.

## Getting component names

This benchmark runs against the built client so its wall-clock budgets mean
something, and the production minifier (oxc) strips `displayName`, leaving
react-scan's per-component tally mangled (`tn`, `ic`, …). Totals and long tasks
are unaffected.

To attribute renders to components, run the same spec against the vite dev
server — point `baseURL` at `http://127.0.0.1:3090` the way
`playwright.config.reasoning-perf.ts` does. Expect the wall-clock assertions to
fail there: a dev build's render path is far slower than anything a user sees.
Use that mode for attribution, this config for budgets.
