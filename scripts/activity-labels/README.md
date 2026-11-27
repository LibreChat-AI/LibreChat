# Activity-label eval harness

Measures the prose quality of fast-model activity-label headers (the collapsed
group headers produced by `activityLabel`). Instruction changes are graded
against a fixed corpus instead of eyeballed on one conversation — the two
hypotheses that felt most obvious when this was built both turned out wrong
under measurement (see **Findings**).

```bash
node scripts/activity-labels/run.mts                       # every variant, 1 sample
node scripts/activity-labels/run.mts --samples 3           # 3 samples each
node scripts/activity-labels/run.mts --variants baseline,shipping --cases fib-rapid
node scripts/activity-labels/run.mts --dry --cases mega-batch    # render prompts, no API calls
node scripts/activity-labels/rescore.mts                   # re-grade stored results, no re-spend
npx tsc -p scripts/activity-labels/tsconfig.json           # type-check the harness
```

Requires `ANTHROPIC_API_KEY` (env or `.env`). A full sweep is roughly $0.03 per
variant and ~45s. Results land in `results/` (gitignored): a timestamped JSON
of every record plus `latest.md` with per-case tables.

## Why the tables matter more than the aggregate

The mechanical checks catch format violations and lexical repetition, but the
failure this feature actually had in production — headers that were
_informationally_ redundant while lexically varied — scores below the overlap
threshold. `results/latest.md` read by eye is the recall instrument; the
aggregate is the regression guard.

## Layout

| File                      | Role                                                                                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captured.json`           | 9 real production payloads pulled verbatim from Langfuse, with the headers that shipped. Irreplaceable — traces age out.                                                                                                                                                                |
| `corpus.mts`              | 17 cases / 28 steps: the captured run as one sequence, plus synthetic cases for modes it never hit (all-failed, partial, parallel, rapid duplicates, entry overflow, truncated output, error-shaped success). Multi-step cases chain each generated label into the next step's context. |
| `prompt.mts`              | Faithful port of the SDK's `buildActivityLabelPrompt`, so synthetic cases render the bytes production would send. Adds `previousLabelCap` for continuity-window experiments.                                                                                                            |
| `variants.mts`            | Single-factor instruction variants. `baseline` is read from the built `packages/api` dist, so drift from the shipped instruction is impossible.                                                                                                                                         |
| `checks.mts`              | Mechanical grading: length, punctuation, markdown, tool-name echo, count echo, and overlap split into `restate` (adds nothing) vs `template` (same frame, new payload).                                                                                                                 |
| `run.mts` / `rescore.mts` | Live runner (production wire shape, `max_tokens: 256`) and offline re-grader.                                                                                                                                                                                                           |
| `types.mts`               | Shared corpus, variant, result, and report types used by the runner and rescorer.                                                                                                                                                                                                       |
| `tsconfig.json`           | Strict, no-emit type-checking configuration for the harness.                                                                                                                                                                                                                            |

## Findings this produced

- **Sentence order is load-bearing.** Moving format constraints after content
  rules cut length violations and register collapse measurably. This is why
  `ACTIVITY_INSTRUCTION` is ordered the way it is — a "tidying" reshuffle
  regresses real output.
- **Enumerating verbs backfires.** An instruction listing acceptable opening
  verbs _anchored_ the model: `Confirmed` went from 18 to 23 occurrences and
  opener diversity halved.
- **Diverse examples alone changed nothing.** Register collapse is task-shaped,
  not example-seeded.
- **Continuity context fixed the real defect.** Feeding committed headers back
  eliminated restatement and, unexpectedly, stopped setup batches from being
  labeled with conclusions their tools had not yet established.
- **A 3-label window is enough.** Unbounded history scored no better —
  restatement is inherently a recency problem — while prompt growth is linear
  (+82 input tokens by batch 9, extrapolating to ~+250 at the `activityMaxPerRun`
  default of 20).
