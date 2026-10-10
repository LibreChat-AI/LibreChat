# Conversation checkout choices

A new coding chat can use the registered checkout directly or request its own
isolated worktree. The choice is part of the conversation's existing machine
and workspace decision, not a separate browser preference. Opening the picker
does not create a checkout; the worker provisions isolation on the first
workspace operation.

## Enable

First update every LibreChat API replica and client. Then opt in on the attached
environment (or the control plane whose schema personal environments inherit):

```yaml
configSchema:
  workspaces:
    allowCheckoutSelection: true
```

The isolated choice requires the selected worker workspace to advertise
`workspaceInstances: [git_worktree]`. A worker configured with
`--conversation-worktree-root` can advertise this capability; use a private
storage directory outside its registered roots. Follow the worker's admission,
capacity and setup runbook. Do not restart workers with active assignments.
Conversation-worktree provisioning and linked-worktree lanes are different
worker configurations and cannot be enabled together on the same worker.

In the composer workspace menu, select a repository, reopen the menu and choose
**Isolated worktree** or **Registered checkout**. The recorded mode stays visible
after reload. Once the chat's decision is sealed, the picker does not implicitly
change that execution target. Continue without a workspace or explicitly attach
again through the deployment's supported decision transitions.
Those transitions offer the same checkout choices. A registered checkout is
available even on a worker without isolation support. Mixed predecessor modes
require an explicit choice before confirmation; they never become automatic
shared-root execution silently.

- **Isolated worktree** uses the worker's admitted Git snapshot. It does not copy
  uncommitted source changes. An unavailable isolation capability fails closed;
  the next command never falls back to shared source files.
- **Registered checkout** uses the existing registered root. Other chats may
  share those files. Normal workspace authorization, approvals, sandboxing and
  scheduling still apply.

No flag and no recorded checkout mode preserves the existing behavior:
workers advertising conversation worktrees use them automatically, and other
workers operate in the registered root. No migration is needed for old chats.
Stored explicit modes require compatible readers; do not enable the flag during
a rolling upgrade or roll back to an older reader while such chats are active.

This control does not select a Git base ref, create a named linked-worktree lane,
archive source, or remove dependencies. The descriptor's `environment.ref` is
operator metadata, not proof of the source's current HEAD. Arbitrary base-ref
selection and archive/restore need additional worker-owned protocol operations.
