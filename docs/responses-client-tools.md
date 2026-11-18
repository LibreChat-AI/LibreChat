# Stored client-tool continuation

A function declared in a Responses request's `tools` is executed by the caller.
When the model selects it, the response returns a `function_call` containing its
`call_id`, name and arguments. With `store: true`, the pending call is retained
in the canonical conversation message and returned by `GET /api/agents/v1/responses/:id`.

Continue a stored completed response by sending the returned response ID and
one result for every pending call:

```json
{
  "model": "agent_example",
  "previous_response_id": "resp_example",
  "store": true,
  "input": [
    {
      "type": "function_call_output",
      "call_id": "call_example",
      "output": "The lookup result"
    }
  ]
}
```

Send the request to `POST /api/agents/v1/responses`. JSON and SSE (`stream: true`)
use the same continuation behavior. Include `tools` again if those functions
should remain available to the model on the new turn.

The response must belong to the authenticated user in the active tenant, and
its conversation must still exist. Current remote-agent authorization continues
to apply. Results resolve only against the selected response's pending client
calls. Unknown or duplicate result IDs, incomplete parallel batches and replayed
calls that change the stored name or arguments are rejected before execution.
Cancelled, failed and incomplete responses cannot supply pending calls.

Stored client handoffs appear in chat history as requests to the client, rather
than cancelled server tools. Completed call/result pairs retain their terminal
state, including empty results. The original handoff remains a historical request
after continuation.

The previous response is immutable. The new turn stores the completed exchange
in its own input, and later turns replay that pair once. Reusing the same prior
response can create a separate branch; it does not consume a global pending call
or provide exactly-once external tool execution.

Explicit replay remains available: send the original `function_call` items and
their matching `function_call_output` items together in `input`. Use explicit
replay for `store: false` responses and older responses whose pending calls were
not retained. Existing stored completed server-tool results are unchanged.

Parallel continuation assumes the initial handoff returned the complete batch.
Provider chunk-shape compatibility, including later calls announced only through
argument deltas, is tracked separately in [#17916](https://github.com/LibreChat-AI/LibreChat/issues/17916).
Stored continuation does not replace the initial run-step handoff.

The regression scenario is
`e2e/specs/mock/scenarios/responses-client-tools.spec.ts`. It runs through the
application with real routing, API-key authentication and MongoDB, using a
deterministic model fixture for single and parallel calls in JSON and SSE modes.
