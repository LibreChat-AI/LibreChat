# Manually Approved Main Promotion

`main` is a release pointer into `dev` history. The **Promote Dev to Main** workflow
moves that pointer to one approved, fully tested `dev` commit. It creates no merge,
rebase, squash, or new commit and never force-pushes. It is not an automated merge bot.

## Trust boundary

```text
maintainer dispatches workflow on main with two exact SHAs
  -> different environment reviewer approves
  -> read-only validation of platform protections, actors, refs and full CI
  -> short-lived App token for this repository, Contents: write only
  -> repeat all validation, fetch into a bare object store, non-forced push
  -> verify the new main SHA and revoke the App token
```

The privileged job runs inline code from the workflow revision on `main`, not a
script from the candidate branch. It does not check out application source, restore
caches, download PR artifacts, install packages, or execute repository-local actions.
The sole action used there is `actions/create-github-app-token`, pinned to a full
upstream commit SHA. The separate policy-test job has read-only permissions, no App
credential, no protected environment, and does not persist checkout credentials.

Inputs travel through environment variables and must be complete lowercase SHA-1
commit IDs before they are used as API or Git arguments. Repository identity, GitHub
hosts, dispatch event, workflow path and `main` ref are fixed. Both the original actor
and any rerun actor must have GitHub's `admin` or `maintain` role. API failures,
incomplete responses, missing CI runs, duplicate/missing jobs and unexpected states
refuse promotion. There is no bypass or "ignore failures" input.

The CI gate accepts only the latest full `push` or `workflow_dispatch` run on `dev`
for the exact input SHA, from the repository's existing backend and frontend workflow
IDs and paths. All build, typecheck, test-shard and circular-dependency jobs must be
present and successful. Only the PR-only **Codegraph select** job may be skipped.
An older successful run cannot conceal a newer failed or pending full run. PR checks
and checks from a different commit do not qualify. This gate does not imply that
Lighthouse, Playwright or integration lanes that only run on PRs tested the resulting
post-merge SHA; maintainers still assess those PR results and release readiness.

The candidate must be the current `dev` tip, and the reviewed baseline must still be
the current `main` tip. `main` must be an ancestor of the candidate. Ref and CI
validation is repeated after approval and immediately before the push. Concurrency
serializes promotion runs without cancelling a job mid-push. Git's non-forced server
update rejects a concurrent change that cannot fast-forward to the candidate. The
cross-ref check is not an atomic lock on `dev`: if it advances after the final read,
`main` still receives only the pinned, previously approved SHA, never the new tip.

## Required repository setup (administrator)

This PR adds code, **not** platform protection settings or credentials. Do not place
the promotion key in repository-wide or organization-wide secrets. Keep it exclusively
in the protected environment below. A missing environment can be auto-created by
GitHub without protection; the inline gate refuses that state before minting a token.

1. Protect **both `dev` and `main`** with rulesets/branch protection:
   - Disallow force pushes and deletions. Require code-owner reviews for workflow,
     script and CODEOWNERS changes, with stale approvals dismissed and approval of
     the most recent reviewable push by someone other than its author.
   - Restrict updates to `main` to release maintainers and the dedicated promotion
     App. A fast-forward App update is not a PR merge: if a PR-only rule prevents
     it, decide the narrowly scoped release-App exception explicitly. Never give
     the App unrestricted bypass of force-push, deletion or other safety rules.
   - `.github/CODEOWNERS` requests Danny's review of the release control plane;
     it enforces nothing until the platform requires code-owner review. Add another
     trusted code owner before Danny-authored control-plane changes can satisfy
     mandatory code-owner review; the author cannot approve their own PR.
2. Create an environment named **`main-promotion`**:
   - Configure trusted **Required reviewers** and enable **Prevent self-review**.
     Use enough trusted reviewers that someone other than the initiator can approve.
   - Disable **Allow administrators to bypass configured protection rules**.
   - Select **Selected branches and tags**. Add exactly one rule: type **Branch**,
     name **`main`**. No tag rule, wildcard, `dev`, or other branch.
3. Create a **dedicated GitHub App**, installed only on `LibreChat-AI/LibreChat`, with
   repository **Contents: read and write** (and GitHub's required metadata access).
   Do not reuse a PAT or a broad existing App. Do not grant Workflows, Actions,
   Administration, Secrets or organization permissions.
4. In that environment only, store:
   - Variable **`MAIN_PROMOTION_APP_ID`**: the dedicated App's ID.
   - Secret **`MAIN_PROMOTION_APP_PRIVATE_KEY`**: its private key.
     The workflow requests a repository-scoped token with only Contents: write. The
     pinned token action attempts revocation in its post-job step, including failures.
     An interrupted runner may not execute cleanup; the installation token's short
     lifetime bounds that residual risk. Do not disable token revocation.
5. Merge this implementation into **`dev`** after review. Bootstrap it onto `main`
   once with a separately approved, ordinary exact-SHA fast-forward; `workflow_dispatch`
   cannot run a new workflow until its definition reaches the default branch.
   Never bypass failed checks or protections as part of bootstrap. Changes to any
   `.github/workflows/`, `.github/scripts/` or `.github/CODEOWNERS` file are deliberately
   excluded from automated promotion, including this workflow's own updates. Those
   use the separately reviewed manual path, so the App needs no Workflows permission.

A repository administrator and the trusted `main` workflow are the root of trust.
This is not a defense against a malicious repository administrator or a compromised
reviewer who knowingly authorizes a malicious release. Nor does it harden the other
existing publish workflows: an App push to `main` intentionally triggers the existing
main-push automation, with its own permissions and dependencies. Review that downstream
publishing surface separately before relying on the release process end to end.

## Promote a normal tested dev commit

1. Run `git ls-remote --heads origin main dev` in your own upstream clone. Review the
   candidate and both **full** CI runs at the exact `dev` SHA.
2. If path filters omitted a full run for that SHA, run the existing **Backend Unit
   Tests** and **Frontend Unit Tests** workflows manually on `dev`, then wait for
   success. Their new `workflow_dispatch` trigger uses full suites, not PR selection.
3. Dispatch **Promote Dev to Main** using branch **`main`**. Supply the full `dev` SHA
   as `dev_sha` and the full current `main` SHA as `expected_main_sha`. Example:

   ```sh
   gh workflow run promote-main.yml --repo LibreChat-AI/LibreChat --ref main \
     -f dev_sha=<approved-current-dev-sha> \
     -f expected_main_sha=<reviewed-current-main-sha>
   ```

4. A different configured reviewer examines the input SHAs and approves the
   `main-promotion` environment deployment. The job still revalidates everything.
5. Read the run summary and confirm `git ls-remote --heads origin main`. Monitor
   downstream main-push publishing workflows separately. If refs or CI changed,
   review a fresh dispatch. If the final read failed after a push, inspect the live
   `main` tip before retrying: the push may have succeeded. Do not force-push.

Rollback of code is a new reviewed revert on `dev`, followed by another approved
fast-forward. Never move `main` backwards. Promotion adds no merge commit, but any
merge commits already present in `dev` are preserved as part of its history.

## Local validation

```sh
python3 -I .github/scripts/test_main_promotion.py
```

Tests extract and execute the workflow's actual inline policy against controlled
API responses and exercise real local bare Git repositories. They never use live
GitHub credentials or update a remote repository. Run the policy-test workflow and
YAML/action lint before delivery. A production promotion cannot be verified until
administrator setup and bootstrap are complete; do not report it as deployed merely
because local tests pass.
