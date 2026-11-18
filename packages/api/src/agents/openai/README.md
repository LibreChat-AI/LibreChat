# Agents API response projection

This module projects an **agent run**, which can include several model invocations and server-executed tools, onto an OpenAI-compatible response. It is not a transparent proxy for a single model completion. Only explicitly client-owned calls in graph-accepted model responses may become outward `tool_calls`; SDK- and provider-executed calls never become client execution requests. Completed SDK executions can be observed separately with the opt-in extension below. Binding caller-supplied tool schemas and client execution remains a separate feature.

## Owners and boundaries

```text
provider adapter -> agents graph -> accepted model response + tool ownership
                                     |
                          SDK accepted-result projector
                              /                  \
                         SSE chunks          JSON accumulator
                              \                  /
                         successful response completion
```

The mounted `/api/agents/v1/chat/completions` Express controller and packaged `createAgentChatCompletion` service both register the SDK's `on_model_response` and `on_model_tools_claimed` handlers for tool projection in streaming and non-streaming mode. Text, reasoning, usage, host-tool execution, billing, artifact writes and authorization retain their respective host handlers. Both hosts call the SDK projection's `finish` after successful execution and `abort` on failure.

## Legacy run-step projector (compatibility export only)

`createOpenAIToolCallStream`, `OpenAIRunStepHandler` and `OpenAIRunStepDeltaHandler` remain exported for existing consumers and their contract tests. Neither in-repo Chat Completions host registers them. The following identity, fragment and terminal rules describe **only** this legacy projector.

### Identity

- A declaring run step owns call identity. Optional provider IDs are aliases, not a prerequisite. Declaration slots keep id-less calls distinct and make snapshot replay idempotent. Provider IDs can repeat in later steps and are not completion-wide identities.
- Outward indexes are allocated once per call across the response. Raw ID substrings are assembled by provider index; shared prefixes such as `call_` are never cross-call aliases. Calls without IDs receive `call_<index>`; collisions receive a suffix. Internal tool execution IDs are not rewritten.
- Argument fragments use provider indexes scoped to a model invocation. A graph delta may name the latest step while referring to an earlier parallel call. When available, the SDK's `getStepBaseKey` supplies invocation scope, including stream segments. A step's scope is retained so late fragments cannot acquire a newer segment's identity.
- Callers without the graph object use metadata scope; callers without that metadata are isolated by step. This fallback cannot reconstruct a missing retry/segment identity.
- Explicit and identified provider indexes take precedence over positional fallback. Positions are used only for multi-call declarations. An unbound singleton may adopt its first provider index; it does not absorb arbitrary later indexes.

### Argument representations

A run-step declaration can contain a **snapshot**: native `args` or OpenAI-shaped `function.arguments`. A run-step delta carries an **append-only fragment**. They must never be concatenated as though they were the same representation.

Both snapshot argument fields accept JSON **strings or objects**, using the shared `Agents.ToolCall` and `Agents.AgentFunctionToolCall` field types. Strings are retained verbatim; objects are serialized once. Nonempty argument fragments take precedence over all snapshots for that call, regardless of arrival order.

### Publication timing

Tool-call IDs and names can also arrive as substrings. There is no per-field completion seal in these events, and the OpenAI-compatible consumer freezes the name on its first chunk. Emitting `get_` and later correcting it to `get_weather` does not work.

Consequently, **tool-call chunks are published only at successful response completion**, after assembling identity and validating arguments. The first chunk contains the complete ID/name; the next carries the complete arguments at the same index. Text and reasoning continue streaming while the run executes. This deliberately sacrifices incremental tool-input display, rather than guessing which names are complete or breaking existing clients. Native JSON responses receive the same completed calls.

Name/ID/argument fragments are append-only and take precedence over the corresponding declaration snapshot. Snapshot replay is idempotent; raw fragments are not deduplicated because identical adjacent fragments can be legitimate and the events carry no sequence token. Split IDs require a provider index for unambiguous correlation. Exactly-once raw dispatch remains an upstream requirement.

### Terminal behavior

`completeOpenAIToolCalls` wraps execution and owns the success/failure boundary. The controller schedules completed-run usage recording before final validation.

| State/event                              | Behavior                                                         |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Open + declaration                       | Allocate identity once; retain snapshot separately               |
| Open + identified fragment               | Bind provider index and append/buffer fragment                   |
| Successful execution                     | Assemble and validate all calls before publishing tool chunks    |
| Failure, abort or invalid terminal input | Discard pending calls; publish no tool-call chunks               |
| Finished                                 | Repeated finish is harmless; later tool events are ignored       |
| Aborted                                  | Later tool events are ignored; finish cannot reopen the response |

Missing names, missing arguments, malformed JSON or unattributable argument data fail terminal projection with bounded errors that omit provider content. A snapshot never repairs a truncated raw stream. Projection bookkeeping is response-local and released on finish/abort; only successfully validated calls are materialized for the response builder. Publication seals before calling the transport, so a transport error or reentrant finish cannot duplicate calls. Already transmitted frames cannot be retracted.

## Accepted-result terminal behavior

The SDK projector accepts only client-disposition calls from graph-accepted responses. A newer accepted text/internal result or a model-tool claim discards superseded calls for that agent. Calls are validated, given unique outward IDs and emitted at successful response completion; failed or aborted runs never publish buffered calls. Internal tools followed by a text answer finish with `stop` and no outward calls. Both in-repo hosts explicitly mark the SDK map as accepted-only when calling the shared serializers: if any accepted client calls remain, the final reason is `tool_calls`, even when text was already emitted. Compatibility consumers of the legacy run-step projector retain the previous `stop` finish reason for historical calls followed by text.

## Verification and limits

- `toolCalls.contract.spec.ts`: shared field types, strings/objects, partial names and IDs, optional IDs, declaration order and transport reentrancy.
- `toolCalls.spec.ts`: identity, representations, ordering, replay, malformed input, failure and abort.
- `toolCalls.graph.spec.ts`: real SDK run with an internally executed tool, plus legacy interleaving and segments.
- `service.spec.ts` and the Express controller spec: both response modes, actual serializers, internal-call suppression, accepted client calls, claim discard and failure behavior.

These tests do not run a live provider, a distributed multi-agent deployment or a persisted resume. The graph test executes a local tool but does not exercise the mounted HTTP server. There is no new database, cache, authorization policy or migration. Code and built packages must deploy together.

## Opt-in server execution results

Both Chat hosts accept the LibreChat extension `include: ["server_tool_results"]`.
It adds completed execution records to `choices[0].message.tool_results` in JSON,
or `choices[0].delta.tool_results` in SSE. A record is `{ call_id, name, arguments,
output }`, all strings; streamed records also carry a stable zero-based completion
`index`. JSON includes an empty array if no results are observed. Omitted `include`
or `include: []` omits the fields. Unknown/malformed selectors return 400 before
execution; duplicate supported selectors are harmless.

```text
accepted model response + sdk disposition (owner/call identity)
  -> SDK ToolNode processed completion + authoritative metadata.agentId
  -> run-local bounded observation projector
  -> JSON tool_results / indexed SSE delta.tool_results
```

For this selector, both Chat hosts disable the SDK's speculative eager tool
prestart. Tools execute after model acceptance, so the observer receives final
processed ToolNode results rather than trying to associate a failed provider
attempt's early output with an accepted fallback. Normal Chat requests and the
Responses API retain their existing execution policy. Custom `createRun` adapters
must forward the supplied `eagerToolExecution: false` option.

This trades tool/model-stream overlap for authoritative result observation:
opted-in tools start after the model finishes its accepted call, and failed
provider attempts do not speculatively execute them. Tool latency may therefore
be higher for opted-in requests; there is no production latency estimate.

The collector never changes execution requests, tool ownership, `finish_reason`,
authorization, billing or artifact callbacks. It consumes only accepted SDK-owned
calls with matching completed execution owner, name and call ID. Pinned SDK 4.2.10
`ToolNode.withToolScope` stamps `metadata.agentId`; `Run` forwards it unchanged.
Missing owner metadata fails closed with an incomplete flag: an ownerless result
cannot be inferred safely from a pending ID when provider/client siblings reuse
that ID. Acceptance deduplication is also scoped by execution owner.

Only processed string arguments/results are exposed; no raw ToolMessage, artifact
or graph-state serialization is performed. Existing tool-output protection and
SDK truncation remain authoritative. Provider-hosted tools without SDK completion
and unfinished/client-executed calls have no invented records. These observations
are distinct from the actionable client `tool_calls` projection above. Responses
API output, persistence and retrieval are unchanged; this selector applies only
to Chat Completions and is not an Open Responses requirement.

Projection-only safety guards bound capture to 1024 accepted server calls and
4 MiB of identity/argument/output UTF-8 text per run, matching the SDK client-call
projection envelope. They are independent of tool execution limits; exhaustion
fences additional observation while preserving completed records and normal graph
success. Smaller guards can be injected into the collector for constrained hosts
and focused tests. Overflow or unattributable ownership adds
`message.tool_results_incomplete: true` in JSON or
`delta.tool_results_incomplete: true` on the terminal SSE chunk. Such records are
not a complete audit log. Partial SSE records also do not imply run success if the
usual execution error follows. No durable Chat storage is introduced.

Successful records survive the existing `completeOpenAIToolCalls` finally-abort
cleanup after `finish`. Failure/cancellation clears unpublished records; late and
duplicate completions cannot append results. Accepted/completed identity state is
released at the run boundary.
