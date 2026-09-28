See CLAUDE.md.

## Branching and pull requests

Normally branch off `dev` and target `dev`; `gh pr create` defaults to `main`, so pass `--base dev`
explicitly. `main` is the released branch, kept as a fast-forward of `dev` and synced as-is — never
open a backport pull request to `main`, because anything merged to `dev` reaches it at the next
sync. Pull requests opened against `main` are retargeted automatically.

**Maintainer-directed canary exception:** Experimental work, or a PR ready to merge after review but
not yet suitable for the next `main` sync, may instead target `canary`. The maintainer may choose
this before work starts or while reviewing a stale PR. For new canary work, branch from the current
`origin/canary` and pass `--base canary` explicitly; do not silently retarget an existing PR or
promote canary code to `dev`. If a stale PR is redirected to canary, first check its base, diff and
reviewed head against current canary; coordinate any rebase or new PR with the maintainer. A PR
explicitly based on `canary` stays there; the main-to-dev retarget workflow does not move it.

Still link related issues in the PR (for example, `Related to #N`) so the work remains
traceable. `Fixes #N` does not close an issue on a `dev` or `canary` merge — GitHub honors closing
keywords only on the default branch. Close resolved issues by hand after merging. Worktrees share
one stash stack, so never use a bare `git stash pop`. See the detailed policy in `CLAUDE.md` under
"Branching and Pull Requests".

Write the description for a reader who has not followed the branch: what breaks, what triggers it,
how it behaves after the change, then one or two views of the mechanism — a focused diff, a call
tree, a shallow file tree, or a Mermaid sequence. Keep only what the change carries, and describe
the code as it stands rather than narrating earlier commits or review rounds. Naming the merged
pull request that caused the bug is not the same thing; that is history the reader needs. The
formats and examples live in `.github/pull_request_template.md`.

## Review and completion

Read the inline review threads themselves — a summary comment or notification list omits findings.
Audit each one against the current code, fix what is valid, and reject what is obsolete in a reply
that says why. After each round: focused tests, `npx tsc --noEmit` in every workspace you changed,
push, then request the next review naming the pull request's exact remote head — a clean review of
an earlier head says nothing about what you just pushed, and CI runs on its own clock. After two
actionable rounds, stop patching thread by thread and read the subsystem by invariant instead.
Which reviewer and what phrase triggers it will change; that the review must cover the exact pushed
head will not.

A clean review is one completion signal, not the definition of done. Ship the observable experience
— loading, empty, success, failure, cancellation, retry, restored session — with strings localized,
accessibility intact, defaults and stored data preserved, and no backend capability left without a
frontend entry point. Report the pushed head, what you ran locally, CI state, the review result at
that head, and any finding you rejected with the reasoning. See `CLAUDE.md` under "Review and
Completion".

## Verification

For startup, auth, config, file, or message-loading changes, avoid serial database
reads and reuse loaded request data. Run `npm run lighthouse` before completion:
the CI lane adds 250 ms per Mongo query and checks the visible conversation's LCP.
See [budgets, reproduction and failure diagnosis](e2e/lighthouse/README.md).

A green build is not a typecheck: `packages/api`, `packages/client` and `packages/data-schemas` build
with `tsdown`, which emits without checking types. Run `npx tsc --noEmit` in the workspace you
changed. `packages/client` excludes `*.spec.ts(x)` and `*.test.ts(x)` from typechecking entirely.
`npm run sort-imports` with no arguments rewrites every source root — pass the paths you touched. See
`CLAUDE.md` under "Typechecking" and "Formatting".

## Module boundaries and configuration

`/api` holds wiring, not behavior. When a change would add logic to a CJS file there — a branch, a
helper, a validation step, a service call — the logic belongs in `packages/api`, and the JS file
keeps requires, route registration and the call into the TS module (`MCPRequestContext.js` is the
shape, thirteen lines of re-export). "Minimum" means how much behavior `/api` gains, not how small
the diff is, and the rule applies to editing existing CJS, which is the common case.

Database contracts belong to `packages/data-schemas`. Keep Mongoose types (`FilterQuery`,
`Types.ObjectId`, `Document`) out of exported signatures in `packages/api`, `packages/data-provider`
and `client`, because they make the storage engine part of that module's public API. Take and return
plain typed objects and express the query behind a data-schemas method. The boundary already leaks
across `packages/api`, so stop widening it rather than rewriting what exists; the client carries none
of it and must stay that way.

New levers ship configurable: a limit, timeout, toggle or capability introduced in code earns a field
on `configSchema` (`packages/data-provider/src/config.ts`) so it can be set in `librechat.yaml`, with
a default that reproduces today's behavior. Hard-coded constants and env-only switches need a reason.
Modules take their dependencies rather than reaching for them: code in `packages/api` receives its
config, database methods and clients from the caller, the way `createModels(mongoose)` receives the
app's connection, instead of importing app singletons or reading global state. Integrations (provider
SDKs, storage backends, vector stores, OAuth servers) arrive through an interface the caller
supplies, so a second implementation is a new argument instead of a new branch. The static singletons
under `packages/api/src/mcp` are the shape to stop extending, not a pattern to copy. This is the
backend half of client state ownership: pass it in, do not reach for it.

See `CLAUDE.md` under "Workspace Boundaries".

## Frontend theming and styling

For frontend work, compose existing `@librechat/client` primitives and variants before adding
feature-local styles. Use semantic theme/Tailwind roles for color and shared appearance; do not
introduce raw palette utilities, hard-coded colors, or arbitrary theme CSS. If the system cannot
express a reusable design need, deepen the shared primitive or versioned theme-token registry
instead of copying classes into a feature. Keep genuine layout and behavior local, and document
why any new custom CSS cannot be expressed by the shared system. See the detailed policy in
`CLAUDE.md` under “Theming and styling.”

## Backend auth cache

When adding or changing code that mutates user documents, invalidate the auth user document cache
for affected users, including bulk role and user mutations. See the detailed policy in `CLAUDE.md`
under “Auth cache invalidation”.

## Client state ownership

The client is migrating from Recoil to Jotai. New state is always Jotai, even in a file that already
imports Recoil; many files import both, so mixed imports say nothing about which to use. For existing
state the unit of conversion is one atom plus every file that reads or writes it, because an atom
cannot be half converted — convert the areas you touch, not the whole store.
Split by ownership: state a feature both writes and reads is feature-owned, so convert it to Jotai
and keep it inside the feature; app-global preferences and shell state a feature merely consumes
(`maximizeChatSpace`, `showScrollButton`, `enterToSend`, artifact visibility) must be passed in
through props or a small host-supplied context rather than reached for through `~/store`; when a
consumer sits outside the feature you are changing, leave that atom on Recoil and pass it in. Passing
them in is what lets a feature move to its own workspace later without a rewrite, and it keeps the
Jotai conversion scoped to the state a feature owns. See the detailed policy in `CLAUDE.md` under
“Client State Ownership”.
