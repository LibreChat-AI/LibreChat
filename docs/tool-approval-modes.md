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
A grant-store outage at pause, resume, invocation or transport keeps a reviewed non-OAuth foreground call one-time, even after storage recovers. OAuth and unknown-auth calls still require verified account generations.
Reject, edit, respond, failed execution, detached launches and expired approvals do not create grants. Success can teach approval only after the execution target has been verified. A launch handle never teaches approval; pending-call ownership is retired at settlement.
A changed connection, active MCP OAuth credential generation, raw upstream tool, schema or mode revision requires fresh approval. Retained OAuth records are ignored when the executing connection uses API-key, direct-bearer or OBO authentication; active MCP OAuth account-change fences remain enforced. Authentication that depends on a runtime-resolved URL remains conservative until detection: manual review pins the stored OAuth generation instead of assuming non-OAuth. OAuth generation changes, including conservative refresh fences, may require another review; token bytes themselves are never consent identity. Review-only authority pins resolved routing and principal identity even when consent cannot be remembered. A manually reviewed non-rememberable connection executes only in the foreground; approving a background request does not authorize detached execution. Execution rechecks the loaded target and current grant before invocation. The approved OAuth generation is pinned to every transport send and recovery retry. Request-scoped, templated or
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

Shared-agent viewers can reset their consent from agent details or the read-only agent panel. Reset does not require EDIT permission or reveal tool configuration. It changes no agent options. Agent-wide reset fences all tools, including unseen in-flight approvals. Stale completions cannot overwrite consent renewed after reset; the per-tool shield menu still supports targeted reset.

Reset accepts the same tenant-scoped `manage:agents` capability or VIEW ACL as normal agent access. It always resets the authenticated user’s consent.

Renewable OpenID/Graph credential placeholders are excluded from review authority in env, arguments, URLs, OAuth fields and headers. Surrounding routing and principal values remain bound. Persistence rechecks OAuth generation and atomically compares the captured consent binding, so stale completions cannot replace consent for a new account, connection, schema or approval revision.

Approval ownership is invocation-specific. A delayed background completion cannot retire a newer call with the same provider ID. Registry timestamps and inspection summaries do not change authority. Renewable placeholders introduced by environment or custom-variable substitution are masked before credential resolution, without changing normal transport resolution.

Scheduled-run pause admission checks each agent’s reachable tools and verified aliases. Options retained for deselected tools do not make an initialized run pause-capable. Unresolved lazy tool surfaces remain fail-closed.
