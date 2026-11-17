# Responses compaction

Operators may enable `POST /api/agents/v1/responses/compact` explicitly:

```yaml
endpoints:
  agents:
    responses:
      compaction:
        enabled: true
        maxInputBytes: 4194304
        maxItemBytes: 1048576
        maxAgeMs: 86400000
        maxClockSkewMs: 30000
```

The request supplies an accessible agent as `model` and an explicit `input`
window. The route uses the existing remote-agent auth, feature, agent-ACL,
content-protection, model configuration, execution lifecycle, billing and
summarization paths. It is a summarize-only operation: tool loading, code/file
resources, skills and subagent graph initialization are excluded. It cannot
start a background run or continue a stored response. Compaction requires
summarization to be enabled for the selected agent/deployment. Agents with an
`sdk_runtime` binding are rejected before initialization: custom/remote runtime
protocols do not yet enforce the required summarize-only operation.

The shared summarizer normally retains recent live turns for the UI. Standalone
compaction has no separate live tail, so it summarizes the explicit window.
Ordinary manual and automatic summarization retain their existing policy.
Complete tool exchanges remain in the summarizer history without loading their
executors; unresolved calls must be completed before compaction.
Summary quality remains model-dependent; an empty or failed summary is an error.

The result is a `response.compaction` object containing an opaque `compaction`
item and usage. Include that item in the `input` of a later Responses request,
followed by new input. Replaying it with `previous_response_id` repeats context;
start a new chain after standalone compaction. Its contents are restored as
assistant conversation data, never as system instructions or executable tools,
and pass through current content protection before reaching the model.

Compaction does not persist a transcript (`store:false`). Its client-carried
state uses authenticated AES-GCM encryption under a key derived specifically
for Responses compaction from the deployment's `CREDS_KEY`. Authentication binds
it to the original user, effective request tenant and agent. Current API authorization is still
required at replay time. Tampering, expiry, another principal/agent, or key
rotation prevents replay. All replicas that accept these items need the same
credential key and synchronized clocks (bounded skew is configurable); malformed keys fail before model work. Existing credential and
private-message encryption formats are unchanged.
