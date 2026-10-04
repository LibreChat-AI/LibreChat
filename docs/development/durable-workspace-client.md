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

One fresh request ID is created before submission; `requestId` optionally supplies
a new caller-owned key. An accepted handle is resumed only with `resumeRequestId`.
Resume is lookup-only, including after 404 or unsupported discovery. A lost
response, including its body, is recovered by lookup. Only a submission without a 202
acknowledgement may be resent, with identical body and queue allowance and only
while that allowance still fits the original run deadline. A known
handle returning 404 is never replayed or sent to the synchronous endpoint.
Admission and execution have a run deadline separate from each HTTP budget.
Credentials refresh on every round trip. Stop/deadline cancellation uses DELETE
on the same ID with an independent transport signal.

The existing background registry owns task handles and single-consumer result
claims. Polling upstream is non-consuming; this transport does not bypass the
manual-versus-wakeup claim. It does not recreate process-local invocations after
LibreChat restarts. Callers that persist invocation state can supply the accepted
ID as `resumeRequestId` to look up the same accepted request. Never resubmit an
expired retained ID.

Zero `maxQueueWaitMs` disables queue retries, not the initial server admission
window. Admission is capped after credential refresh by the remaining run time
minus execution/delivery reserve. Durable terminal codes use the existing domain
status mapping; unknown codes and upstream error messages are not disclosed.
Both transports share the workspace span and one final outcome log.

Successful lookup headers establish acceptance before reading the body. Losing
that body and later seeing 404 never grants replay authority. Before acceptance,
only complete typed execution-limiter 429s can retry under `codeApiMaxRetryWaitMs`.
Server retry hints and cumulative wait/run budgets bound those retries. A never-
uncertain rejected submission can recalculate admission; uncertain submissions
retain their full fingerprint.

Confirmed capability support retains the configured command budget. Unsupported
servers lower only omitted Bash defaults to an executable synchronous budget.
Explicit timeoutMs is never lowered; an oversized explicit request fails before
dispatch. Timeout diagnostics reflect the selected fallback budget.
