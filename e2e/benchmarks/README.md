# Agent startup latency benchmark

This non-gating Playwright benchmark measures a fresh agent chat from the user's Enter keypress to:

- the agent-chat POST response ending (`submitToAckMs`);
- the mock assistant token appearing in the message DOM, before browser paint
  (`submitToFirstContentMs`);
- the interval between those events (`ackToFirstContentMs`).

The first request is reported separately as `cold`. Warmups and measured samples each use a new
conversation, and measured conversations are deleted so history growth does not bias later samples.
Each report also captures host load and CPU utilization to make contaminated runs visible.

Run the default in-memory, minimal-agent profile with:

```sh
npm run e2e:benchmark:agents
```

Useful environment variables:

| Variable                     | Default     | Purpose                                                     |
| ---------------------------- | ----------- | ----------------------------------------------------------- |
| `E2E_LATENCY_PROFILE`        | `minimal`   | Use `mcp-memory` to exercise MCP and memory startup.        |
| `E2E_LATENCY_TURN`           | `first`     | Use `follow-up` to measure a constant one-turn history.     |
| `E2E_LATENCY_WARMUPS`        | `5`         | Number of unreported warmup samples after the cold request. |
| `E2E_LATENCY_SAMPLES`        | `30`        | Number of samples included in the summary.                  |
| `E2E_LATENCY_LABEL`          | `unlabeled` | Identifies the revision or block in the JSON report.        |
| `E2E_LATENCY_GIT_SHA`        | `unknown`   | Records the tested revision in the JSON report.             |
| `E2E_LATENCY_STREAM_MODE`    | `in-memory` | Describes the stream backend in the report.                 |
| `E2E_LATENCY_MONGO_DELAY_MS` | `0`         | Adds a controlled delay before each Mongoose query.         |
| `E2E_LATENCY_OUTPUT`         | unset       | Writes the complete report to this path.                    |

To exercise Redis streams, point the E2E server at a disposable Redis instance:

```sh
USE_REDIS=true \
USE_REDIS_STREAMS=true \
REDIS_URI=redis://127.0.0.1:16379 \
E2E_LATENCY_STREAM_MODE=redis \
E2E_LATENCY_PROFILE=mcp-memory \
npm run e2e:benchmark:agents
```

For a base-versus-HEAD comparison, use identical dependencies and benchmark files, alternate blocks
in base/HEAD/HEAD/base order, and exclude the cold samples. Report both block medians as well as the
pooled median; do not remove outliers from an otherwise valid block. Avoid running builds, test
workers, or other CPU-heavy work at the same time.

`E2E_LATENCY_MONGO_DELAY_MS` is useful for a separate simulated-I/O profile that reveals changes to
the request's asynchronous critical path. Always label and report that profile separately from the
zero-delay local result; it is a controlled workload, not a claim about production database latency.

The `follow-up` turn profile creates one unmeasured seed exchange before every sample, then measures
the next request and deletes the conversation. This exercises conversation/history reads without
allowing the history to grow across samples.
