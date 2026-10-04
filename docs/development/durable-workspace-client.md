# Durable workspace transport

Requires Code API's durable workspace capability (code-interpreter PR #302).
Enable per attached environment after all Code API replicas support it:

```yaml
admission:
  durableRequests: true
  queueWaitMs: 180000
  transportTimeoutMs: 10000
  pollIntervalMs: 500
```

Settings use the existing environment user-config schema, not a new global
endpoint. Defaults preserve legacy synchronous behavior. Capability discovery
accepts version 1, falls back only on 404/version 0, and fails closed otherwise.

One request ID is created before submission. A lost response is recovered by
lookup; only an unobserved submission may be resent with that same ID. A known
handle returning 404 is never replayed or sent to the synchronous endpoint.
Admission and execution have a run deadline separate from each HTTP budget.
Credentials refresh on every round trip. Stop/deadline cancellation uses DELETE
on the same ID with an independent transport signal.

The existing background registry owns task handles and single-consumer result
claims. Polling upstream is non-consuming; this transport does not bypass the
manual-versus-wakeup claim. It does not recreate process-local invocations after
LibreChat restarts. Callers that persist invocation state can supply `requestId`
to resume the same accepted request. Never resubmit a retained ID after expiry.
