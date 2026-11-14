# A remote SDK agent in real LibreChat

This example runs an actual `@librechat/agents` Run in another Node process and sends its native
SDK events through LibreChat's existing handlers, message persistence, approvals, and Agents UI.
The default model is deterministic so the example requires no provider key. The LibreChat server,
management API, browser UI, graph execution, tools, and checkpoint transport are real.

Build the shared packages from the repository root (`npm run build:data-provider`,
`npm run build:data-schemas`, `npm run build:api`) and build/start LibreChat normally. Merge the
configuration fragment alongside your existing endpoints; do not replace your complete config.
Set the same random `SDK_RUNTIME_SECRET` (at least 32 characters) in LibreChat and the worker.

```sh
node examples/sdk-runtime/server.cjs
```

Register a saved agent using the existing Management API or update an existing agent's binding:

```json
{
  "name": "Remote graph example",
  "provider": "openAI",
  "model": "gpt-4.1-mini",
  "sdk_runtime": { "id": "remote-example", "protocolVersion": 1 }
}
```

The host provider/model must be permitted by your existing LibreChat configuration. The worker
owns its own model configuration; the host does not forward its provider credentials. Select the
saved agent in the normal Agents picker and send a message. Approve `inspect_example` when asked.
The graph plans, runs an SDK agent with a real tool, reviews, then refines through a conditional
loop. Reload during execution or while awaiting approval, resume, stop, and inspect saved history.
Stop cancels this example's execution; it does not automatically undo completed side effects.

Set `SDK_EXAMPLE_GRAPH=simple` for the minimal one-agent example in `minimal.cjs`.
The default `agent.cjs` demonstrates a custom StateGraph with planning, SDK tool execution,
review, and conditional refinement. For actual provider calls,
set `SDK_EXAMPLE_LIVE_MODEL=true`, `OPENAI_API_KEY`, and optionally `SDK_EXAMPLE_MODEL` **on the
worker**. Set `SDK_EXAMPLE_STEP_DELAY_MS=10000` to make reconnect/stop easy to observe. Set `SDK_RUNTIME_AGENT_IDS` to a comma-separated allowlist of saved agent IDs for an
additional deployment restriction.

Use the supplied Mongo checkpointer configuration for approvals that survive rebuilding a worker Run.
Serve production workers through TLS (`wss://`) and enforce network access to the deployment.
Only loopback workers may use unencrypted `ws://`. Browser clients never receive the runtime secret.

The bridge is an execution transport, not a second renderer. Browser reconnect uses LibreChat's
existing job stream. A lost host-to-worker connection aborts execution and fails the turn; it is
not automatically retried because custom tools may have side effects. Approval resumes rebuild a
fresh worker Run against host-owned checkpoints, without sharing database credentials.

Remote runtimes execute their own operator-installed tools. The bridge deliberately does not
forward host provider credentials, MCP tokens, tool registries, or arbitrary host tool-execution
requests. Configure domain data access inside the trusted worker and authorize it using the
signed caller identity. Host policy hooks still gate SDK tool execution.

## Measuring transport overhead

With the worker running, run `node examples/sdk-runtime/benchmark.cjs` with the same secret.
It compares five warm executions of the identical deterministic custom graph locally and in the
separate process, reporting first text event and completion medians. It includes Run construction
and the socket handshake, but excludes browser rendering, TLS, WAN latency, and provider inference.
Use the browser test `e2e/specs/mock/remote-sdk.spec.ts` for native approval/reload/stop verification.
Its test attachment also records send-to-approval and approval-to-visible-output timings.
