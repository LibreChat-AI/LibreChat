# Responses API compatibility

LibreChat serves agent-backed Responses requests at `/api/agents/v1/responses`.
The `model` identifies an agent, and existing remote-agent authentication and
resource permissions apply. Protocol compatibility does not grant additional
agent, model, tool, or file access.

## Function-tool reporting

Returned function definitions describe the tools actually applied to the run.
They include `type`, `name`, `description`, `parameters`, and `strict`, including
when optional request fields were omitted. A missing description is returned as
`null`; missing parameters use the same empty object schema supplied to the model.

The runtime does not enforce strict function-argument generation, so it reports
`strict: false`, including when a request asks for strict generation. This
preserves the existing generation behavior while making the effective capability
explicit. Consumers must validate tool arguments before executing them. A
caller-owned function never gains a server-side executor through this reporting.
Hosted tools that were not applied are not reported as applied client functions.

## Acceptance-test reference

The compatibility audit uses the official Open Responses suite at
[`dce9ddb91921427c2ba06901c7dfaf0cc7056799`](https://github.com/openresponses/openresponses/tree/dce9ddb91921427c2ba06901c7dfaf0cc7056799),
with the `2026-04-24` schema. Run the suite from that revision with its locked
Bun dependencies:

```sh
bun run test:compliance --base-url http://127.0.0.1:3080/api/agents/v1 \
  --model <accessible-agent-id> --json
```

Supply a disposable local API key using `OPENRESPONSES_API_KEY`. The suite's raw
result includes unsupported optional transports as failures; record those
separately from defects in enabled features without changing or skipping the
suite's assertions. Its sample phase-schema check does not call the endpoint.
A deterministic provider fixture proves schema and execution plumbing, not live
provider capabilities or semantic output quality.
