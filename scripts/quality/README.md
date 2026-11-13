# Pull request quality reports

PR commands and manual runs report change risk for changed lines and added or edited
functions in `packages/data-schemas`, `packages/api`, and the backend `api` folder.
Mutation testing is experimental. It mutates changed code in `packages/data-schemas` only. Support for more scopes is planned.
Only workspaces with changed source get report jobs. PR updates do not start source
reports. PostgreSQL contract and readiness tests still run automatically for changes
to their schema and lifecycle paths. Report jobs also provide PostgreSQL and provision
the MongoDB test binary before tests start. Changes to the quality tooling still run its own verification tests automatically.
Low scores do not fail a check. Failed tests, invalid reports, and tool errors do. A mutant with
a `RuntimeError` or `CompileError` result does not fail the run: it is shown in the report as
invalid and excluded from the scores.
Mutation jobs have a 240-minute limit. Change-risk jobs have a 45-minute limit.
A workflow timeout is a failed run, not a quality score. A Stryker `Timeout` result
means a mutated program timed out; Stryker counts that mutation as detected.

1. Mutation testing uses Stryker 10.1.1. It mutates only changed executable lines, not whole
   functions. A changed simple statement (an expression statement, a declaration, a `return` or
   `throw`, or the header or test of a compound statement) mutates in full, including every line
   of a changed multi-line statement. A block, function body, or class member mutates in full
   only when every executable line it spans changed; an edit inside a nested function never pulls
   in its unchanged parent, and an edit in the parent never pulls in an unchanged nested function.
   A deletion-only edit mutates its enclosing simple statement only when the deletion point sits
   strictly inside it; a deletion between statements selects nothing, and is still recorded.
   A renamed file with no other edit selects nothing; a new file selects every line. Blank lines
   and comment-only lines never count as changed. Standalone, side-effect-free
   `logger.<error|warn|info|debug|verbose|silly>(...)` calls are not mutated, including the
   mutation that empties a block made up only of such calls; any other call, including one with
   a side-effecting argument, mutates normally. A changed file carrying a `// Stryker disable`
   comment with no reason or naming `all` is listed in the selection summary as advisory; it
   does not fail the run.
   It selects related Jest tests and uses per-test coverage to reduce repeated work.
   Static mutations are disabled by default. These run outside an individual test,
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
   A shard summary counts the changed functions that its own ranges touch, and the files that
   hold them. Files whose mutated ranges are all outside functions are counted separately.
   A final job combines the JSON reports and calculates one score from mutant counts. It runs
   only when the shard jobs succeeded or failed; when tooling verification fails or the run is
   cancelled, the shards do not run and the final job is skipped.
   It checks the head, plan, source, and every expected mutation. Missing shards, duplicate
   mutations, or incomplete results prevent a combined score. A shard with runtime or compile
   errors still combines normally: those mutants are reported as invalid and excluded from
   the score, the same as a shard with no such errors.
   The live Actions log shows progress every 30 seconds. It separates static mutations
   from other mutations and lists each unfinished function. A completion line shows
   the result counts for each finished function. Elapsed time and time since the last
   result help identify slow work. Pending means unfinished; it does not identify
   which mutation a worker is currently running.
   `progress.jsonl` saves each result as it arrives. `progress.json` contains the latest
   progress snapshot and marks whether the report is complete. Failed runs upload
   partial output when the artifact step can still run. Runner loss or a hard timeout
   can prevent that upload.
2. Change risk selects whole functions; this selection is separate from mutation's changed-line
   selection. The selector compares each function's code with the base version. Comments and
   spacing do not count as code changes.
   An edit that only deletes code still selects the containing function.
   Editing a nested function does not select its unchanged parent or siblings.
   An edited parent also excludes unchanged nested function bodies from mutation.
   Moving unchanged code within a file does not select it. File renames count as additions.
   Deleted functions have no score in the new source. Changed module-level code outside
   functions gets no complexity or CRAP row, but its changed executable lines still appear in
   the change-risk test-gap section. Mutation testing mutates changed ranges outside functions
   as well; the shard summary counts those files separately.
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

The default command scope is `all`: change risk for `data-schemas`, `api` (`packages/api`),
and `server` (the backend `api` folder). A mixed change can run three risk jobs and
four data-schemas mutation shards. API-only or backend-only changes run no mutation jobs.
Manual `workflow_dispatch` runs can choose `risk`, `mutation`, or `both`, use `all`
or a comma-separated scope list, and set static mutants on or off. Mutation testing
stays limited to data-schemas in all cases. The selection summary
lists risk workspaces, mutation workspaces, and workspaces outside the scope.
Related Jest tests supply coverage for the changed files. Coverage uses each
workspace's existing worker count and memory recycling. API Redis integration
suites run separately with Redis enabled, using the same groups and serial lanes
as cache CI. The API report runner provides both the single Redis instance and the
repository's three-node Redis cluster. Istanbul merges the groups' coverage before
function scores are calculated. All groups use the same Jest coverage directory so
they can reuse compiled code. After each group, its raw reports move into its own
directory, including when tests fail. Every group still runs its tests with the
workspace's existing timeouts. Tests can exercise unchanged code, but only added
or edited functions appear in the risk report.

`packages/api` changes also get evidence from `api/`'s own specs through a source alias, bounded
by the repository variable `QUALITY_ALIAS_BUDGET_MINUTES` (an integer from 1 to 25 minutes,
default 20; an invalid value fails the run). A pass that exceeds the budget, crashes, or produces
no results file leaves native coverage in place and marks only the affected files incomplete,
without failing the job.
The pass compiles `packages/api/src` to loose CommonJS (plain `exports.x = x` assignments, as
in the built bundle), so specs that spy on or partly mock `@librechat/api` behave as they do
against the bundle.
In normal CI, a spec that mocks or imports a `packages/api/src` file by relative path gets a
module separate from the bundle. The pass keeps that separation: its resolver loads such
relative requests from `api/` through a symlink to `packages/api/src` at
`coverage/source-alias/src`, and the mirror's own relative imports stay in the mirror. A spec's
`jest.mock` of a source file therefore does not replace that file inside
`jest.requireActual('@librechat/api')`. The pass also collects coverage from the mirror path;
Istanbul records it under the real file, so both copies add to one entry. The runner removes the
symlink after the pass. Related-test selection (`--listTests`) does not use the mirror.

Coverage from several runs merges only when each run's entry has the same statement-map hash.
A file with nothing to instrument, such as a type-only module, has an empty entry with no hash
in every run; those entries merge and the file is measured with no executable lines. A file
that is incomplete or unavailable shows that state instead of a percentage in the refactor
hints table, and its CRAP is `N/A`. The test-gap section lists such files after the measured
ones, once for each state, reason, and evidence scope; a group of more than 5 files is
collapsed. Each uncovered changed-line range in the test-gap section
is a fenced code block of up to 8 lines, with each line cut at 160 characters.

## PR commands and merge decision

A user with repository write access can post one of these commands as a new PR
conversation comment. Edited comments do not start or change a request.
The bot adds an eyes reaction to valid commands from authorized users. This includes
ignore and duplicate requests. If GitHub cannot add the reaction, processing continues.

```text
/quality risk scopes=data-schemas,api,server
/quality mutation scopes=data-schemas static=off
/quality check-all
/quality check-all scopes=data-schemas static=on
/quality ignore
```

`scopes` defaults to `all`. `static` defaults to `off` and only affects mutation
runs. `all` means the supported scopes for the chosen check. Risk supports
`data-schemas`, `api` (`packages/api`), and `server` (the backend `api` folder).
Mutation supports only `data-schemas`. A `check-all` request runs both checks. It uses the selected scopes
for risk and includes mutation only when `data-schemas` is selected.
`/quality both` remains an alias for `/quality check-all`. The manual workflow and
local runner also default to static mutants off.
Unknown scopes, duplicate options, and invalid values are rejected before work starts.

One accepted request can run per PR. Repeating the same effective command for the
same commit while it runs returns its existing link. Different valid options cancel
the previous request before new report jobs start. A finished request can be repeated.
Validation and the repository write-access check happen before cancellation.
Invalid commands and unauthorized users leave the current run and gate unchanged.
Cancellation only targets accepted comment requests from this repository and PR.
Other PRs, unrelated workflows, tooling verification, and standalone manual runs
are not cancelled by a request.

The bot records the exact PR head and base commits when it accepts a request.
One bot comment shows the status and Actions link first, then lists the commit,
requester, check, effective scopes, static option, and the change-risk and mutation scopes.
An ignore request shows only the commit, requester, and check. It updates after selection and tooling verification,
then again when the workflow ends. The final comment lists job outcomes and links
to report artifacts. Job rows show change risk, then mutation shards 1 to 4, then the mutation
report, each in scope order (`data-schemas`, `api`, `server`). Links show change-risk reports
first, then each scope's combined mutation report before its shards in order. The comment
footer states which outcomes close the gate. Scores and function details stay in those reports and the
Actions summaries. Mutation logs provide the detailed 30-second progress updates.
A failed or cancelled workflow is shown as such. A new PR commit cancels old-commit work and marks earlier
request comments outdated. The current request can be rerun with its original
commit and options. Reruns of superseded requests or older commits are stopped.
Post a new command to measure the current commit or use different options.

`Quality decision` is a commit status. It waits for an explicit decision on each
new PR head; it does not keep a runner idle. The latest accepted request for that
commit owns the status:

4. A selected run clears the gate only after the workflow succeeds. A successful
   empty selection also clears it. Low scores remain advisory.
5. The gate stays closed unless the workflow, source selection, tooling verification, and
   every report job succeed. A report job fails on a failed test in its workspace's own Jest
   run, a tool error, a job timeout, or an incomplete mutation report, including a mutation
   shard that reaches its execution budget. A cancelled workflow also keeps the gate closed.
   A change-risk file marked incomplete or unavailable, for example by a failed `api/`
   source-alias suite, does not close the gate. Retry the run or make a new explicit decision.
6. `/quality ignore` cancels active quality work, then clears the gate and records
   who chose to skip the checks. An older run finishing cannot replace it.
7. A new accepted run makes the gate wait again. A duplicate active command does
   not change it. A new commit requires a new request or a new ignore decision.
   Manual workflow dispatches do not count as explicit comment decisions.

Request admission and status publication share one queued concurrency group per PR. Each reads the latest
head and decisions before it writes. This prevents an older result from reopening
the gate after a newer request has made it pending.

## Inline comments

A completed, requested data-schemas mutation run can leave a bounded number of inline
survivor comments on the PR diff. The repository variable `QUALITY_INLINE_LIMIT` caps new
comments per tested commit; it must be an integer from 0 to 20, defaults to 5, and falls
back to that default with a warning on any other value. `0` turns inline comments off.
Inline publishing never changes the `Quality decision` outcome: scores stay advisory, and a
publishing failure is logged, not surfaced as a gate failure.

The unprivileged mutation job writes a `quality-findings` artifact listing survived
mutants with a stable key, head-relative source location, rank, risk tags, and a short
reason, plus a `detected` list of the keys of mutants proven `Killed` or `Timeout` this
run (see below). A key is computed from the mutant's file, mutator, original and replaced
text, enclosing function name, and an ordinal that only disambiguates otherwise-identical
tuples in the same file — never from its line or column — so the key survives line shifts
across commits. The ordinal is assigned by position (file, then line, then column) over
every mutant in the run regardless of status, so it stays stable whether a mutant is
`Survived`, `Killed`, `Timeout`, or (on a budget-limited partial run) still `Pending`.
One consequence: if an earlier identical mutant (same file, function, mutator, original,
and replacement) leaves or joins the changed-line selection at a later head, every later
identical mutant's ordinal, and therefore key, shifts by one. The privileged `Publish inline mutant comments` job in `quality-decision.yml` never
checks out or runs PR code. It downloads that artifact by run ID, then validates it from
scratch: exactly one `findings.json` under the 1 MB cap, strict schema and range checks
(hex lengths, integer ranges, enum values, path traversal, text length caps), and that the
artifact's repository, PR, base, and head match the tested commit before any of it is
used. A run's own `head_sha` is the default branch for an `issue_comment` run, so the
publisher binds to the bot's request record instead — matched by request id and
`attempt <= run_attempt`, the same binding `comment.mts` uses — and trusts that record's
`head` for the PR head check, the findings' expected head, and the posted review's
`commit_id`.

Per-field truncation (original/replacement/reason text) still leaves room for a run to produce
more findings than the 2000-finding cap, or a serialized artifact that exceeds the 1 MB cap on a
run with many large findings. The writer closes both gaps itself: after truncation, it drops
findings from the low-priority tail of the already rank-sorted list until the kept count is
within the 2000-finding cap and the artifact fits the byte cap, and records how many in the
artifact's required `omitted` field — findings dropped for either reason, `0` when nothing was
dropped.
`omitted` is exported from and checked in both the writer (`findings.mts`) and the privileged
consumer (`inline.mts`, which imports the writer's own `MAX_ARTIFACT_BYTES` instead of keeping a
second copy). A nonzero `omitted` means the artifact's survivor list is incomplete the same way a
`partial` budget-limited run's is, so it disables stale-comment marking the same way.

A finding is only bound to the PR when its file is in the diff. A single line must sit on
a RIGHT-side added or context line of one hunk; a multi-line range must lie inside one
hunk. A range crossing a hunk boundary anchors a single-line comment at the first added
line inside it, or is dropped if none exists. Everything unbound stays in the report only.
A stale PR head (moved past the tested commit) skips publishing entirely.

Bound survivors are selected by the artifact's own `rank` field, then file and line; tags
are informational and never reorder a finding ahead of a lower rank. Existing comments are
found by a hidden marker (`<!-- quality-mutant:v1 key=... head=... posted=... -->`) and
matched only when posted by the bot. `posted` is the head a key was first commented at and
is never rewritten; new posts are capped per tested head, at `QUALITY_INLINE_LIMIT` minus
the bot comments already carrying that head. A surviving key already commented, at any
head, is never reposted; its `head` field is updated in place if the head changed. A
previously reported key no longer surviving is marked stale with a prepended, idempotent
note, but only when the run's findings are `complete` (never for a `partial` budget-limited
run or one that dropped findings to fit the byte cap), the key is in the artifact's
`detected` list, and the comment's file was mutated this run and still carries a patch in
the diff — the narrowest file set known to have run: every survivor's file, plus every PR
file under the tested workspace. A key missing from both `findings` and `detected` was
never positively resolved this run — it could be `Ignored`, `NoCoverage`, invalid, or (on a
partial run) never reached — so that alone never marks its comment stale; only a key
proven `Killed` or `Timeout` does. Everything is posted as one PR review (event `COMMENT`)
against the tested commit, using `line`/`side: RIGHT` and `start_line` for a multi-line
finding.

The review has a short body, because the timeline otherwise shows only "github-actions
reviewed" and "Files changed" can collapse a large file behind "Load diff":

```text
Mutation testing at <sha7>: <N> mutants survived on changed lines. <K> are commented inline
in this review (limit <L> per commit). The full list is in the [mutation report](<link>).

Commented locations:

- [`<path>:<line>`](<server>/<repo>/blob/<head>/<path>#L<line>)
```

`N` is the artifact's listed survivors plus its `omitted` count, prefixed with "at least" for a
`partial` run. `K` is the number of comments in this review, and `L` is `QUALITY_INLINE_LIMIT`.
The link is the artifact's `reportUrl` when it is a valid `https:` URL, otherwise the Change
Quality run, which holds the report as a step summary and the `report.md` artifact. The
locations link to the tested commit's blob, with each path segment URL-encoded (parentheses
included) and the display text in a code span with control characters replaced. A run that
posts no new comment posts no review.

Comment bodies use plain markdown and neutral wording ("this mutant survived"), fence the
original and replacement text with a fence longer than any backtick run inside it, and
never render the artifact's free-text `reason` or an unvalidated `mutator`: the body states
only the finding's validated `tags` as fixed labels, and `mutator` is rejected at
validation unless it matches `/^[A-Za-z]+$/`.

## Mutation report

Each data-schemas mutation run produces a step summary and a `report.md` artifact, built
from the four shards' merged JSON report. Both hold the same sections, in this order:

1. **Test gaps on changed lines** — survivors first. A survivor is a mutation a passing test
   suite did not detect; the report calls it "not detected by tests", never a bug. Each row
   lists the location, mutator, original and mutated code, and risk tags.
2. **No coverage** — changed lines no test executed, grouped per file into contiguous line
   ranges.
3. **Invalid mutants** — `CompileError`/`RuntimeError` mutants, listed individually: location,
   mutator, original and mutated code, and the reason Stryker gave (`statusReason`, truncated
   and escaped the same way as the other code cells). Stryker could not run these to a result
   at all; they are excluded from the scores and are never `Survived` or `NoCoverage`.
4. **Status** — one row per result, kept distinct: `Killed`, `Timeout`, `Survived`,
   `NoCoverage`, `Ignored` (broken down into `static`, `logging-only`, or the exact
   `Stryker disable` reason text), and `Invalid` (`CompileError`/`RuntimeError`). `Timeout`
   is never folded into `Killed`: a mutated program that hangs is a distinct outcome from one
   a test actively caught.
5. **Scores** — two numbers, each labeled with its formula:
   - `Killed by assertion`: `Killed / (Killed + Survived + NoCoverage)`. Excludes `Timeout`
     from both sides; only a test that actively failed counts here.
   - `Stryker mutation score (counts timeouts as detected)`:
     `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)`. Matches Stryker's own
     definition, where a timeout counts as a detected mutant.
     Both are `N/A (no valid mutants)` when their denominator is zero. Either way, `Invalid`
     mutants are excluded from both the numerator and the denominator.
6. **Suppression advisory** — changed `Stryker disable` comments with no reason or naming
   `all`, carried from the plan's advisory list. Informational; it does not affect the score.
7. **Source of truth** — a pointer to the merged JSON report (`mutation.json`) and its HTML
   report (`mutation.html`, rendered with `mutation-testing-elements`, the same viewer
   Stryker's own HTML reporter uses), which hold every mutation location.

Ranking (the `rank` field, lowest first) groups survivors by what they put at risk, not by
how new the surrounding code is. Narrow keyword sets over the mutated code, its enclosing
function name, and the file path assign one or more tags — `authorization`, `tenant`,
`credentials`, `data-loss`, or the `behavior` fallback — and the lowest-priority tag (in that
order) sets the rank's leading digit. Within a tag, emptying an object literal used as a
filter (`{}`) ranks first, a conditional/equality/logical/boolean mutator ranks next, and
everything else (including a plain `StringLiteral` change) ranks last. Being inside a newly
added function is not an input to this ranking: the same mutation ranks identically whether
its enclosing function is new or unchanged. The `quality-findings` artifact (see
[Inline comments](#inline-comments) above) carries only `Survived` findings and this rank;
the full report above carries every status.

### Execution budget

The repository variable `QUALITY_MUTATION_BUDGET_MINUTES` caps the wall-clock time one
mutation shard's Stryker run may take. It must be an integer from 1 to 230 minutes; unlike
`QUALITY_INLINE_LIMIT`, an invalid value fails the run with a clear error instead of falling
back to a default, because a silently wrong budget could hide a shard that is actually
running far longer than intended. Unset defaults to 60. Stryker's JS API has no run
abort, so each shard runs as a supervised child process and is signalled (`SIGTERM`, then
`SIGKILL` after a grace period) if it is still running when the budget elapses.

A shard that hits its budget does not fail outright. It writes a `completion.json` with
`status: 'partial'`, the mutant results already finished (from `progress.jsonl`, flushed as
each result arrives), and the exact ids of the mutants that never ran. The merge step accepts
a partial shard only when its finished and unfinished mutants together exactly cover that
shard's planned set, with no mutant missing, duplicated, or unexpected; any other mismatch is
rejected the same way a missing or malformed complete shard is. A merge that includes a
partial shard sets the findings artifact's `status` to `'partial'`, adds an "Execution budget
reached" section to the report naming the unfinished mutants, and exits non-zero with the
distinct message `incomplete: execution budget reached` — separate from a tooling failure, so
a dashboard or future automation can tell "ran out of time" apart from "broke". The findings
and report artifacts still upload, because the upload step runs with `if: always()`.

### Incremental reuse: evaluated, not enabled

Stryker supports an incremental mode that reuses a prior run's per-mutant results from a
cache file keyed by source hash and configuration, skipping mutants whose covering code and
tests are unchanged. It was evaluated for this pipeline and is not enabled. A comment-
triggered run on a PR branch can be requested again after a force-push, a rebase, or a change
to the merge base; a cache populated by an earlier, different commit on the same branch name
or workflow cache key could then report a mutant as already killed when the code it covers
has since changed, silently hiding a real regression. The four shards also run concurrently
against what would need to be one shared cache, and GitHub Actions cache writes are not
safe for concurrent writers. Reusing results safely would need a cache keyed and invalidated
per exact head commit, which removes most of the reuse incremental mode offers in a
comment-triggered workflow where most requests are for a commit that has never run before.
Each run stays a full run.

## Activation

The command and completion workflows must reach the repository default branch
(`main`) before GitHub can run their `issue_comment` and `workflow_run` triggers.
Merging this PR into `dev` alone does not activate those triggers. Follow the normal
`dev` to `main` promotion; do not backport the workflows separately.

After live command tests pass, an administrator can add `Quality decision` as a
required status in the target branch's protection rule or ruleset. Select GitHub
Actions as its expected source. The status alone does not block merging until that
rule exists. The activation work remains part of PR #18025. Source reports now
require an explicit command or manual dispatch. Tooling verification remains
automatic for changes to the quality scripts, workflows, and dependencies.

Live checks must cover a successful selected run, `static=off`, an invalid command,
a requester without write access, `/quality ignore`, cancellation, a failed test,
a newer commit during a run, and a rerun of an older commit. Confirm that comments
update in place and that only the current commit's latest decision clears the gate.
Also confirm that duplicate requests reuse their run and that replacements never
cancel another PR, unrelated CI, or standalone manual runs.

Rule sources:

8. [Stryker configuration](https://stryker-mutator.io/docs/stryker-js/configuration/)
9. [Stryker Jest runner](https://stryker-mutator.io/docs/stryker-js/jest-runner/)
10. [SonarJS](https://github.com/SonarSource/SonarJS)
