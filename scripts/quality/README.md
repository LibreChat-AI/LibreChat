# Pull request quality reports

Every pull request runs two advisory checks for changed `packages/data-schemas` source.
Low scores do not fail a check. Failed tests, invalid reports, and tool errors do.
Each job has a 45-minute limit. A timeout is a failed run, not a quality score.

1. Mutation testing uses Stryker 10.1.1. It mutates only added or edited functions.
   It selects related Jest tests and uses per-test coverage to reduce repeated work.
   Static mutations remain enabled. These run outside an individual test, such as
   during module loading or a shared test hook. Stryker reruns the related tests
   for each mutated file.
   The artifact includes an HTML report and a JSON report with mutation locations.
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
GitHub merge commit. Both checkouts and commands use the same head SHA. The workflow
uses read-only permissions and needs no secrets. Reports appear in the Actions job
summary and in downloadable artifacts. It does not post PR comments.

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
node --test scripts/crap.test.mts scripts/quality/*.test.mts
```

The automatic scope is `data-schemas`.
Other workspaces can be selected manually with `workflow_dispatch`; those mutation
configurations have not been validated by this trial. The selection summary lists the
workspaces excluded by the selected scope. `all` selects every changed application workspace.

Rule sources:

1. [Stryker configuration](https://stryker-mutator.io/docs/stryker-js/configuration/)
2. [Stryker Jest runner](https://stryker-mutator.io/docs/stryker-js/jest-runner/)
3. [SonarJS](https://github.com/SonarSource/SonarJS)
