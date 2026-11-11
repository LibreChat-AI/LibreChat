# Pull request quality reports

Automatic pull request runs report change risk for added or edited functions in
`packages/data-schemas`, `packages/api`, and the backend `api` folder.
Mutation testing runs only for added or edited functions in `packages/data-schemas`.
Only workspaces with changed source get report jobs.
Low scores do not fail a check. Failed tests, invalid reports, and tool errors do.
Mutation jobs have a 240-minute limit. Change-risk jobs have a 45-minute limit.
A timeout is a failed run, not a quality score.

1. Mutation testing uses Stryker 10.1.1. It mutates only added or edited functions.
   It selects related Jest tests and uses per-test coverage to reduce repeated work.
   Static mutations are enabled by default. These run outside an individual test,
   such as during module loading or a shared test hook. With `static=on`, Stryker
   reruns the related tests for each mutated file. `static=off` sets Stryker's
   `ignoreStatic: true`. Static-only mutants remain in the report as `Ignored`.
   They do not affect the score. Mutants covered both during loading and inside
   tests still run with per-test coverage. The exact-plan check includes ignored
   results; it never treats a missing result as an ignored mutant. Each shard plan
   records the static option. Shards with different options cannot be combined.
   Four GitHub jobs run separate mutation ranges, with two Stryker workers per job.
   The planner counts mutants before testing and assigns the largest ranges first
   to the shard with the fewest mutants. Each original range stays intact: splitting
   a block containing nested functions could remove its block-replacement mutation.
   A large indivisible range can therefore make one shard slower than the others.
   Sharding reduces waiting time but repeats setup and baseline tests on each runner.
   It does not split or exclude the tests available to a mutation.
   Each shard artifact includes an HTML report and a JSON report with mutation locations.
   A final job combines the JSON reports and calculates one score from mutant counts.
   It checks the head, plan, source, and every expected mutation. Missing shards,
   duplicate mutations, runtime errors, or incomplete results prevent a combined score.
   The live Actions log shows progress every 30 seconds. It separates static mutations
   from other mutations and lists each unfinished function. A completion line shows
   the result counts for each finished function. Elapsed time and time since the last
   result help identify slow work. Pending means unfinished; it does not identify
   which mutation a worker is currently running.
   `progress.jsonl` saves each result as it arrives. `progress.json` contains the latest
   progress snapshot and marks whether the report is complete. Failed runs upload
   partial output when the artifact step can still run. Runner loss or a hard timeout
   can prevent that upload.
2. Change risk uses the same function selection. The selector compares each function's
   code with the base version. Comments and spacing do not count as code changes.
   An edit that only deletes code still selects the containing function.
   Editing a nested function does not select its unchanged parent or siblings.
   An edited parent also excludes unchanged nested function bodies from mutation.
   Moving unchanged code within a file does not select it. File renames count as additions.
   Deleted functions have no score in the new source. Module-level expressions outside
   functions are excluded from both checks.
   The report includes all function expressions, arrow functions, callbacks, and methods.
3. CRAP combines classic ESLint cyclomatic complexity with statement coverage:
   `CC² × (1 − coverage)³ + CC`. Nested functions own their statements.
   Cognitive complexity comes from the published `sonarjs/cognitive-complexity` rule.
   It is a separate score and does not replace CC in the CRAP formula.

Reports compare the PR head with its merge base. They do not measure the synthetic
GitHub merge commit. Application source and test dependencies come from the PR head.
Quality tooling and the combined-report job use the workflow revision, so older PR
heads do not need to contain the tooling scripts. Jobs that execute PR code have read-only permissions and need no secrets. Separate
jobs accept commands and publish comments and the merge status. They use trusted
workflow code, do not install PR dependencies, and do not open report artifacts.
Reports appear in the Actions job summary and in downloadable artifacts.

The selector knows these source owners: `api`, `client`, `packages/api`, `packages/data-provider`,
`packages/data-schemas`, `packages/client`, and `packages/chat`. Each uses its own Jest
configuration. Source under the package `src` directories and legacy `api` is eligible.
Tests, fixtures, declarations, generated output, and compatibility harnesses under `misc`
are excluded. Source outside those owners is listed in the selection summary. Build and
CI scripts have separate test commands; they do not have an application Jest owner.

Coverage comes from related tests in the owning workspace, not from end-to-end tests
or every consumer of a built package. No coverage evidence produces `N/A`, never a
zero-risk score. A zero-hit instrumented function is untested. Scores are sorted with
the highest CRAP first. This report style is inspired by
[crapper](https://github.com/unclebob/crapper); its metric definitions are not substituted
for the repository's existing CRAP calculation.

From the repository root, after `npm ci` and `npm run build:packages`:

```sh
node scripts/quality/changes.mts --base origin/dev
node scripts/quality/run.mts --base origin/dev --workspace data-schemas --check risk
node scripts/quality/run.mts --base origin/dev --workspace data-schemas --check mutation
# Run one of the four CI shards (indices 1 through 4).
node scripts/quality/run.mts --base origin/dev --workspace data-schemas --check mutation --shard 1
node --test scripts/crap.test.mts scripts/quality/*.test.mts
```

The automatic scope is `all`: change risk for `data-schemas`, `api` (`packages/api`),
and `server` (the backend `api` folder). A mixed change can run three risk jobs and
four data-schemas mutation shards. API-only or backend-only changes run no mutation jobs.
Manual `workflow_dispatch` runs can choose `risk`, `mutation`, or `both`, use `all`
or a comma-separated scope list, and set static mutants on or off. Mutation testing
stays limited to data-schemas in all cases. The selection summary
lists risk workspaces, mutation workspaces, and workspaces outside the scope.
Related Jest tests supply coverage for the changed files. They can exercise unchanged
code, but only added or edited functions appear in the risk report.

## PR commands and merge decision

A user with repository write access can post one of these commands as a new PR
conversation comment. Edited comments do not start or change a request.

```text
/quality risk scopes=data-schemas,api,server
/quality mutation scopes=data-schemas static=off
/quality both scopes=all static=on
/quality ignore
```

`scopes` defaults to `all`. `static` defaults to `on` and only affects mutation
runs. `all` means the supported scopes for the chosen check. Risk supports
`data-schemas`, `api` (`packages/api`), and `server` (the backend `api` folder).
Mutation supports only `data-schemas`. A `both` request uses the selected scopes
for risk and includes mutation only when `data-schemas` is selected.
Unknown scopes, duplicate options, and invalid values are rejected before work starts.

The bot records the exact PR head and base commits when it accepts a request.
One bot comment shows the requested checks, effective scopes, static option,
requester, and Actions link. It updates after selection and tooling verification,
then again when the workflow ends. The final comment lists job outcomes and links
to report artifacts. Scores and function details stay in those reports and the
Actions summaries. Mutation logs provide the detailed 30-second progress updates.
A failed or cancelled workflow is shown as such. A new PR commit marks earlier
request comments outdated. Re-running an Actions run keeps its original commits
and options. Post a new command to measure a new commit or use different options.

`Quality decision` is a commit status. It waits for an explicit decision on each
new PR head; it does not keep a runner idle. The latest accepted request for that
commit owns the status:

4. A selected run clears the gate only after the workflow succeeds. A successful
   empty selection also clears it. Low scores remain advisory.
5. Failed tests, tool errors, timeouts, cancellations, or incomplete reports keep
   the gate closed. Retry the run or make a new explicit decision.
6. `/quality ignore` clears the gate and records who chose to skip the checks.
   It does not cancel an existing run. An older run finishing cannot replace it.
7. A new request for the same commit makes the gate wait again. A new commit
   requires a new request or a new ignore decision. Automatic reports and manual
   workflow dispatches do not count as explicit comment decisions.

Status publication jobs share one concurrency group per PR. Each reads the latest
head and decisions before it writes. This prevents an older result from reopening
the gate after a newer request has made it pending.

## Activation

The command and completion workflows must reach the repository default branch
(`main`) before GitHub can run their `issue_comment` and `workflow_run` triggers.
Merging this PR into `dev` alone does not activate those triggers. Follow the normal
`dev` to `main` promotion; do not backport the workflows separately.

After live command tests pass, an administrator can add `Quality decision` as a
required status in the target branch's protection rule or ruleset. Select GitHub
Actions as its expected source. The status alone does not block merging until that
rule exists. Keep automatic quality reports enabled until the comment path has
passed live checks. The activation work remains part of PR #18025; no automatic
report trigger is removed by this change.

Live checks must cover a successful selected run, `static=off`, an invalid command,
a requester without write access, `/quality ignore`, cancellation, a failed test,
a newer commit during a run, and a rerun of an older commit. Confirm that comments
update in place and that only the current commit's latest decision clears the gate.
Keep automatic tooling verification when retiring the automatic report trigger.

Rule sources:

8. [Stryker configuration](https://stryker-mutator.io/docs/stryker-js/configuration/)
9. [Stryker Jest runner](https://stryker-mutator.io/docs/stryker-js/jest-runner/)
10. [SonarJS](https://github.com/SonarSource/SonarJS)
