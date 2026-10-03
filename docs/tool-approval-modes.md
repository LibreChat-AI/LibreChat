# Agent tool approval modes

MCP tool rows expose a shield menu beside defer, programmatic, background and intent options.
The header menu changes all currently listed tools. Newly discovered tools inherit policy.
Selections belong to the agent, not the shared MCP server.

| Mode                          | Behavior                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------- |
| Inherited                     | No agent-specific rule.                                                      |
| Always ask                    | Review each call.                                                            |
| Always approve                | No agent-specific prompt. Administrator requirements still win.              |
| Ask once per chat             | Remember a successful, manually approved call for this user, agent and chat. |
| Ask once, then always approve | Remember it for this user and agent across chats.                            |

Remembered approval covers different arguments. The approval view discloses that scope.
Reject, edit, respond, failed execution, detached launches and expired approvals do not create grants. Success can teach approval only after the execution target has been verified. A launch handle never teaches approval; pending-call ownership is retired at settlement.
A changed connection, OAuth credential generation, raw upstream tool, schema or mode revision requires fresh approval. OAuth generation changes, including conservative refresh fences, may require another review; token bytes themselves are never consent identity. Review-only authority pins resolved routing and principal identity even when consent cannot be remembered. Execution rechecks the loaded target and current grant before invocation. The approved OAuth generation is pinned to every transport send and recovery retry. Request-scoped, templated or
unresolved connections cannot retain approval. Reset in the tool menu revokes your grants
across chats. In-flight approvals cannot restore a revoked grant. Refresh and reconnect do not reset a chat.

## Activation

Upgrade every serving replica before enabling authoring:

```yaml
endpoints:
  agents:
    toolApproval:
      enabled: true
      mode: bypass
      agentModes: true
      grantLookupTimeoutMs: 3000
```

Explicit administrator deny/ask rules and hooks remain authoritative. Approval grants do not
supply missing permissions or credentials. Hosts without a supported approval responder block
calls requiring review. An inner/programmatic path that cannot evaluate the agent policy refuses
execution rather than treating an automatic mode as a bypass. Input/output scripts are not part of this feature.

## Compatibility and rollback

Existing agents inherit policy. Disabling `agentModes` disables authoring and remembered grants;
stored manual-review requirements remain enforced while endpoint approvals are enabled.
Older clients can drop these fields when editing agents. Do not enable authoring during a rolling
upgrade. Before downgrading the server, enforce affected tools through administrator ask/deny
rules and stop active runs. Do not downgrade into a bypass baseline that ignores agent requirements.

## Personal reset

Shared-agent viewers can reset their consent from agent details or the read-only agent panel. Reset does not require EDIT permission or reveal tool configuration. It changes no agent options. Agent-wide reset fences all tools, including unseen in-flight approvals; the per-tool shield menu still supports targeted reset.
