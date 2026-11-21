# Agents API tool-call index reproduction

## Verdict

The index mismatch is real. PR #16203 fixes the zero-index example but is not a safe fix: it regresses a working nonzero-index stream and still loses parallel and later-turn tool calls.

This is an investigation branch, not a production fix. The companion `.cjs` harness asserts the observed failure matrix, so a successful harness exit confirms reproduction, not correct production behavior.

## Revisions and dependencies

| Input                                                  | Revision                                   |
| ------------------------------------------------------ | ------------------------------------------ |
| LibreChat `dev`, also the codegraph's indexed head     | `f192308f4c2c6a66ded2dba18ab625c16e974c4f` |
| PR #16203 controller                                   | `f991566383393fc4f5c4345f6954d696adf54dbc` |
| Agents graph used for source navigation                | `d3534feea81c35e386a6a4137b58599e92d6a24d` |
| Executed agents package, matching LibreChat's lockfile | `@librechat/agents@3.9.0`                  |
| Executed client                                        | `@ai-sdk/openai-compatible@1.0.22`         |
| Node                                                   | `24.16.0`                                  |

The PR source differs from the tested `dev` controller only in its proposed loop/index change and whole-file CRLF conversion.

## Run

Run from this branch's worktree root. No credentials, database, running application, or paid model invocation are needed. Dependency installation and fetching the public PR file require network access; the replay itself does not.

```bash
mkdir -p .repro
npm install --prefix .repro/runtime --ignore-scripts --no-audit --no-fund \
  @librechat/agents@3.9.0 @ai-sdk/openai-compatible@1.0.22 typescript@5.9.3

gh api \
  'repos/danny-avila/LibreChat/contents/api/server/controllers/agents/openai.js?ref=f991566383393fc4f5c4345f6954d696adf54dbc' \
  --jq .content | base64 -d > .repro/pr-openai.js

node scripts/reproduce-tool-stream-index.cjs
```

The parser version matches the repository lockfile. The harness uses TypeScript's parser to select existing code, not a hand-copied implementation of the suspect logic. All three harness dependencies live under `.repro/runtime`; a full monorepo install is not required.

Outputs:

- Console: results for each implementation/scenario/mode.
- `.repro/results.json`: graph events, raw serialized SSE chunks, server tracker contents, consumer output/error, and finish reason for every replay. This generated file is intentionally not committed.

## What actually executes

```text
Synthetic Bedrock Converse contentBlockStart/contentBlockDelta events
  -> real agents Bedrock message-output adapter
  -> real AIMessageChunk instances
  -> real ChatModelStreamHandler
  -> real StandardGraph + HandlerRegistry
  -> actual controller on_run_step / on_run_step_delta closures
  -> actual createChunk / writeSSE / sendFinalChunk
  -> real @ai-sdk/openai-compatible doStream consumer
```

The non-streaming runs exercise the same controller closures with `isStreaming = false`, the actual content aggregator and `buildNonStreamingResponse`. They assert identity, tool name, complete arguments, and call count, not merely that no exception occurred.

Controller closures and response helper functions are extracted by AST from the checked-out source and executed unchanged in an isolated VM scope. The whole Express controller is not booted. The consumer's injected `fetch` returns the captured SSE instead of making an HTTP request. No tools are actually invoked: multiple-round fixtures explicitly feed separate model invocations through the graph metadata boundary. The reported `2 -> 1` shape is a constructed two-invocation fixture, not a capture from the reporter's deployment.

## Observed matrix

Each row runs in both streaming and non-streaming mode against both implementations, for twenty replays total. “Correct” here means tool identities/counts/arguments, not finish-reason policy.

| Model output                                    | `dev`            | PR #16203                      |
| ----------------------------------------------- | ---------------- | ------------------------------ |
| One tool at provider index zero, no text        | Broken           | Correct                        |
| Text at block zero, tool at block one           | Correct          | **Regresses**                  |
| Two tools in one model response                 | Broken           | Still broken                   |
| Later model invocation reuses index zero        | Broken           | Still broken, silent call loss |
| Two earlier content steps, tool delta index one | Broken, `2 -> 1` | Still broken, `0 -> 1`         |

### Minimal regression

For text followed by a tool at Bedrock content-block index one, the real graph emits:

```json
{
  "index": 1,
  "stepDetails": {
    "type": "tool_calls",
    "tool_calls": [{ "name": "get_time", "args": {}, "id": "call_a", "type": "tool_call" }]
  }
}
```

Notice that the inner tool call has **no `index`**. On `dev`, the outgoing ID/name and arguments both use one. Under the PR, they become:

```json
{"index":0,"id":"call_a","type":"function","function":{"name":"get_time","arguments":""}}
{"index":1,"function":{"arguments":"{\"city\":"}}
{"index":1,"function":{"arguments":"\"Madrid\"}"}}
```

The actual client throws:

```text
AI_InvalidResponseDataError: Expected 'id' to be a string.
```

### Parallel tools

The real `handleToolCalls` path emits separate run-step events, each with a singleton `tool_calls` array. Both initial chunks fall back to `position === 0` in the PR, while their argument deltas use provider indexes zero and one. The first call succeeds, then the second call raises the missing-ID error.

In the PR's non-streaming mode, the map retains only `call_a` with Madrid arguments; `call_b` is lost. On `dev`, Paris arguments are attached to `call_a`, while `call_b` has empty arguments. These are identity/data-association errors, not just presentation errors.

### Multiple model invocations

The PR emits both `call_a` and `call_b` under outgoing index zero when each invocation starts its provider indexes at zero. The client has already finished the first call and silently ignores the second call. The server tracker keeps the first identity and appends both JSON documents:

```text
call_a -> {"city":"Madrid"}{"city":"Paris"}
```

The non-streaming response likewise contains only the first identity with concatenated, invalid arguments.

## Source findings and invariant review

- **Located by graph:** the Express route and existing controller spec import the CJS controller. `handleToolCallChunks` is reached from the agents stream handler. Graph navigation is not runtime proof.
- **Read in source:** Bedrock uses `contentBlockIndex` on raw tool chunks. The graph's initial `ToolCall` records omit that field. `handleToolCalls` emits singleton tool-call steps, so array position is not provider identity. The CJS controller uses a different key for initiation and deltas, ignores raw-delta `id`/`name`, and shares these paths between streaming and non-streaming responses.
- **Observed in runs:** the matrix and client errors above. All event production and graph dispatch are real SDK code, not fabricated `on_run_step` fixtures.
- **Identity invariant:** each outward tool-call index must identify one tool ID for the lifetime of the outward completion. Neither a content-step ordinal nor an unscoped provider index is sufficient.
- **Parallel/interleaved delivery:** multiple calls must keep distinct identities even when they arrive in different initial arrays. The fixture covers two tool blocks in one response, not concurrent multi-agent lanes or arbitrary interleaving.
- **Retry/later invocation:** the multiple-invocation fixture demonstrates index reuse. Actual cancellation, retry orchestration, stale-event filtering and resumption were not exercised and would need tests for a production fix.
- **Persistence/auth/upgrade:** this is a response-projection replay; it makes no persistence changes and bypasses HTTP authorization. No persistence, tenant isolation, mixed-version deployment or migration claim is made.
- **Alternate consumers:** the actual route uses the inline CJS callbacks, not the similarly named handler classes in `packages/api/src/agents/openai/handlers.ts`. Testing those classes alone would miss this bug. This reproduction does not establish whether the normal LibreChat chat UI is affected.
- **Finish reason:** the PR's description overstates the existing fix. `sendFinalChunk` switches to `tool_calls` only when tool calls exist **and no text was emitted**. The text-plus-tool replays still finish with `stop`. This is a separate observed policy, not included in the identity-correctness assertions.

A production fix should correlate raw tool deltas (which carry ID/name/index on initiation) within their model-invocation scope, allocate stable outward indexes, and use the same identity mapping for streaming and non-streaming. It must preserve identity across parallel calls and repeated provider indexes. This branch does not implement that fix.

## Verification boundary

The replay, syntax check, formatting/import checks and touched-file lint are the relevant checks for this standalone investigation script. No production files or TypeScript workspace files are changed. Full controller Jest tests, workspace typechecks, live Bedrock requests, application HTTP/e2e tests and multi-agent concurrency tests are not part of this reproduction.
