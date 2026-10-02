# Native BYOM acceptance

Run one deterministic, opt-in acceptance test through the real LibreChat UI →
authenticated Code API → outbound paired `@librechat/code` CLI → native SRT path.
Only the model is a fixture. No paid model credentials are needed.

## Prerequisites

- A built LibreChat checkout, including its client and workspace packages, with
  development dependencies and Playwright Chromium installed.
- A built `LibreChat-AI/code-interpreter` checkout with service dependencies and
  `packages/code` dependencies installed. Build both the service and code package.
  The standalone service build currently also needs its async Python template:
  `cp service/src/matplotlib-async.py service/.build-service/src/matplotlib-async.py`.
- Node 24, `redis-server`, and the native SRT prerequisites for your platform.
  macOS uses Seatbelt; Linux requires Bubblewrap and Socat. `rg` must be on PATH.
  The code package's existing native-runtime documentation is authoritative.
- MongoDB Memory Server can use its cached binary or download one on the first run.

From the LibreChat root:

```sh
BYOM_CODE_REPO=/absolute/path/to/code-interpreter node e2e/byom/run.mjs
```

To also exercise a saved non-coding chat switching to a coding agent without implicit access,
sending and reloading in **No workspace** mode, attaching explicitly, and leaving an offline
workspace before continuing the same chat:

```sh
BYOM_WORKSPACE_TRANSITIONS=true BYOM_CODE_REPO=/absolute/path/to/code-interpreter node e2e/byom/run.mjs
```

This enables the decision protocol and attach/detach policy only in the disposable test app.

The `Native Workspace Acceptance` workflow runs both variants on a hosted macOS
runner when the harness changes in a `dev` pull request. It pins the Code API/worker revision
and uses the native Seatbelt policy unchanged. It does not upload identities, raw logs or
browser state. This proves the macOS journey only; Linux and WSL2 require their own native run.

Optional: `BYOM_REDIS_BIN` selects an absolute Redis executable,
`BYOM_CODE_CLI` selects a separately built worker CLI, and
`E2E_CHROMIUM_CHANNEL=chrome` uses an installed Chrome instead of Playwright Chromium.
The worker package/toolchain must be readable under its native sandbox policy;
do not relax that policy to make the test pass.

## What must pass

1. Self-service enrollment through LibreChat and real CLI pairing for two workers.
2. Native SRT capability reported by each worker, plus approved sandboxed Bash.
3. Standalone approved `create_file` physically writes the expected bytes.
4. A subsequent `read_file` returns those bytes through LibreChat.
5. Selecting **Accept edits** lets `edit_file` persist without a prompt; a browser
   reload and another turn see the edit, while commands continue to require approval.
6. Rejected creation leaves no file, and creation has no side effect before approval.
7. Selecting worker B does not expose worker A's file; B's write leaves A unchanged.
8. Stopping B produces a persisted tool failure, not success or fallback to A.
9. Selecting **Full access** runs commands and physically creates a file without
   approval prompts, survives reload, and can switch back to **Ask before changes**.
10. Giving one agent an explicit additional-machine list lets new chats select worker B,
    persist that choice across reload, and still start on default worker A in a separate chat.
    Both chats read different physical files. An offline B never falls back to A.

The disposable fixture enables `endpoints.agents.statefulCodeSessions.allowEnvironmentSelection`
and the environment-decision protocol. Production deployments keep fixed-agent routing unless
that opt-in is enabled and the agent has a nonempty `code_environment_ids` list. The default
`code_environment_id` is implicitly allowed; every additional machine still requires the user's
own access and current worker capabilities. This does not move an existing chat between machines.

Each coding agent in the graph contributes its machine requirement, including lazy subagents.
The composer identifies an unselected agent and machine beneath the picker, and each machine
section lists its agents. Agents may share one selection when they explicitly allow that machine.
Explicit choices record the choosing agents in `codeWorkspaces[].agentIds`, so Lia can use B
while a fixed reviewer stays on A. Ownership survives persistence, reload and decision sealing.
Legacy selections without ownership prefer the selected default; without it, exactly one
permitted target must match. Independent fixed-machine requirements survive alternative picks.
Update every API replica and refresh clients before enabling the opt-in: old validators reject
ownership-bearing choices rather than silently rerouting them. The builder also permits removing
saved machines that are no longer accessible, without blocking unrelated edits to the agent.

`maxEnvironmentChoices` limits additional machines per agent (default 32, ceiling 128). The
builder uses the same limit; create, update, duplicate and restore authorize all listed machines
against the loaded principal-scoped config before reserving database references.

Assertions inspect **tool outputs**, not echoed arguments or the model's final prose.
The default hosted Code API URL is deliberately pointed at an invalid local route,
so an accidental routing regression can never send fixtures to a production endpoint.

## Isolation and evidence

Every run creates its own MongoDB, Redis, Code API, LibreChat, two worker identities,
and workspaces. Ports are dynamically assigned, not the usual development ports.
Listeners are loopback-only. No existing database, launchd worker, pairing, or project
directory is reused. Children receive an allowlisted environment; checkout `.env`
keys are neutralized. Mutations default to real UI approval; the test explicitly selects
**Accept edits** for one file edit, then **Full access** for unattended commands and
file creation. Returning to **Ask before changes** restores approval prompts.

The command stops its children on success, failure, SIGINT, and SIGTERM. The private
temporary run directory is printed and retained for debugging; it contains test-only
identity files and logs, so do not publish it. Playwright traces, screenshots, and
videos are disabled to avoid recording authentication or pairing material. A successful
test attaches a small assertion summary. Exit status is nonzero on failure.

This is not a whole-suite runner and is not enabled implicitly in ordinary CI.
Run it after relevant routing, approval, worker, or dependency changes. It proves the
tested native workflow, not fleet load capacity, sandbox escape resistance, remote
Git authentication, or attachment/artifact transport. Windows should run it inside
WSL2; a macOS pass does not certify WSL2/Linux support.

## Dependency

Requires LibreChat #15675 (standalone create-file routing). Keep the acceptance PR
stacked on that fix until it lands in `dev`, then retarget to `dev`. Do not merge the
acceptance branch into an already-merged feature branch.
