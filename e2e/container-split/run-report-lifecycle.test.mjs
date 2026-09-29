// run-report-lifecycle.test.mjs — unit tests for the run report at the two ends of a run that never
// reaches stage 11.
//
// reporter.mjs writes run-report.json from inside the Layer B Jest run, which is stage 11. That left
// two holes, and both produced a MISREADING rather than a missing file:
//
//   * A failed run left the PREVIOUS run's report on disk, so the next reader took an hour-old tally
//     for this run's result. `removeStaleRunReport` deletes it at run start, before stage 1, so the
//     file's presence means this run wrote it.
//   * A run that failed at bring-up discarded the twelve backend-lane catalog ids Layer A had already
//     decided at stage 1, because the only writer of the report lived in the stage the run never
//     reached. `buildEarlyRunReport` / `writeEarlyRunReport` produce that run's report instead.
//
// Three lines have to hold in that early report, and each is asserted below rather than assumed: an
// unexecuted check never reads as passed (Req 5.10), a setup-failure run still exits non-zero
// (Req 5.9), and the setup failure itself stays legible so a report recording Layer A passing cannot
// be mistaken for a successful run (Property 9).
//
// Pure over injected values and a temp directory — no Docker, no Jest-in-Jest, no touching the real
// artifact. Native-ESM Jest under e2e/container-split/jest.config.mjs (its `**/*.test.mjs` pattern).
// Touches no application code or container-split script (NG1/NG2).

import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SETUP_FAILURE_KINDS,
  SetupFailure,
  removeStaleRunReport,
  isBackendLaneCheck,
  classifyLayerAOutcomeFor,
  readLayerASummary,
  buildEarlyRunOutcomes,
  buildEarlyRunReport,
  writeEarlyRunReport,
  writeEarlyRunReportSafely,
  validateWrittenRunReport,
  runLayerBChecks,
  LAYER_A_SELF_SKIP_MARKER,
  LAYER_A_RESULT_ENV,
} from './run.mjs';
import { CHECK_CATALOG, CHECK_IDS, catalogEntryFor } from './check-catalog.mjs';
import {
  CHECK_STATUS,
  SKIP_REASON,
  ENUMERATED_SKIP_REASONS,
  buildRecords,
  runOutcome,
  serializeRun,
} from './serializer.mjs';
import ContainerSplitReporter, {
  PATH_OUTCOMES_UNUSABLE_KIND,
  RUN_REPORT_PATH,
  outcomeFromAssertion,
  sidecarPathFor,
} from './reporter.mjs';
import { formatUndecided } from './undecided.mjs';
import { IMAGE_RECORD_ENV, readImageRecord } from './image-record.mjs';
import {
  PATH_OUTCOME,
  PATH_OUTCOMES_PATH,
  consumePublishedPathOutcomes,
  publishPathOutcomes,
} from './path-outcomes.mjs';
// The REAL per-path decision rule and the REAL list summary, so the round-trip below carries the shape
// a live run produces rather than a hand-written literal that could agree with the channel while the
// live payload does not.
import {
  AUTH_SURFACE_UPSTREAM,
  classifyExercise,
  summarizePathExercise,
} from './checks/path-exercise.filter.mjs';

// The backend-lane ids, derived from the catalog rather than listed, so this file cannot be the place
// the two drift apart.
const BACKEND_LANE_IDS = CHECK_IDS.filter((id) => isBackendLaneCheck(id));
const LAYER_B_IDS = CHECK_IDS.filter((id) => !isBackendLaneCheck(id));

// A Layer A spawn result shaped the way the exec seam resolves one.
const layerAPassed = { status: 0, stdout: '', stderr: '' };
const layerASelfSkipped = {
  status: 0,
  stdout: '',
  stderr: `${LAYER_A_SELF_SKIP_MARKER} (api/test/container-split): \`mongosh\` was not found on PATH.\n`,
};
const layerAFailed = { status: 1, stdout: '', stderr: 'grant shape drifted' };

const bringupFailure = () =>
  new SetupFailure(
    SETUP_FAILURE_KINDS.BRINGUP_CONTAINER_FAILED,
    'Bring-up failed because a container did not stay up: harness-auth-surface (exited (1)).',
    { service: 'auth-surface', detail: 'a log tail' },
  );

// A tested-image identity record, the shape resolveImage produces (task 17.5).
const imageRecord = Object.freeze({
  reference: 'ghcr.io/example/librechat:harness',
  id: 'sha256:abc123',
  createdAt: '2024-02-03T04:05:06.789Z',
  provenance: 'reused',
});

describe('removeStaleRunReport — the previous run\u2019s report is gone before stage 1', () => {
  test('it names the path reporter.mjs writes, not a second spelling of it', () => {
    // Two independently-spelled paths would make the deletion silently miss the file the reporter
    // writes, which is the whole failure mode this guard exists to close.
    expect(path.basename(RUN_REPORT_PATH)).toBe('run-report.json');
  });

  test('an existing report is removed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-report-'));
    const reportPath = path.join(dir, 'run-report.json');
    await writeFile(reportPath, '{"stale":true}\n', 'utf8');

    const result = await removeStaleRunReport({ reportPath });

    expect(result).toEqual({ removed: true, path: reportPath });
    await expect(stat(reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an absent report is not an error — a first run has none', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-report-'));
    const reportPath = path.join(dir, 'run-report.json');

    await expect(removeStaleRunReport({ reportPath })).resolves.toEqual({
      removed: false,
      path: reportPath,
    });
  });

  test('a failure that is NOT "no such file" is rethrown rather than swallowed', async () => {
    // If a stale report exists and cannot be removed, continuing would leave exactly the artifact
    // this deletion exists to prevent. Failing loudly beats proceeding with a file that will be read
    // as this run's result.
    const remove = async () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    };
    await expect(
      removeStaleRunReport({ reportPath: '/nope/run-report.json', remove }),
    ).rejects.toMatchObject({
      code: 'EACCES',
    });
  });
});

describe('isBackendLaneCheck — the catalog\u2019s own layer decides it', () => {
  test('the eleven Layer A suites and the static NG3 guard are backend-lane', () => {
    expect(isBackendLaneCheck('GRANT-SHAPE-01')).toBe(true);
    expect(isBackendLaneCheck('PROVISION-AUTHSOURCE-11')).toBe(true);
    expect(isBackendLaneCheck('COMPOSE-UNCHANGED-12')).toBe(true);
    // Twelve ids, which is exactly what Layer A decides at stage 1.
    expect(BACKEND_LANE_IDS).toHaveLength(12);
    for (const id of BACKEND_LANE_IDS) {
      expect(['A', 'static']).toContain(catalogEntryFor(id).layer);
    }
  });

  test('a Layer B, recorded or both-layer check is not backend-lane', () => {
    expect(isBackendLaneCheck('TOPO-BRINGUP-16')).toBe(false);
    expect(isBackendLaneCheck('PARITY-SUITE-31')).toBe(false);
    expect(isBackendLaneCheck('RUN-REPORT-32')).toBe(false);
  });
});

describe('classifyLayerAOutcomeFor — Layer A\u2019s exit status is not the whole story', () => {
  test('exit 0 with no self-skip marker is a pass', () => {
    expect(classifyLayerAOutcomeFor('GRANT-SHAPE-01', layerAPassed)).toEqual({
      status: CHECK_STATUS.PASS,
    });
  });

  test('exit 0 WITH the self-skip marker is a skip for a grant suite, never a pass', () => {
    // Jest exits 0 whether the suites ran or self-skipped for want of mongosh, so the marker is the
    // only thing that distinguishes them. Reading a self-skip as a pass would be the exact false pass
    // Req 5.10 forbids.
    const outcome = classifyLayerAOutcomeFor('GRANT-SHAPE-01', layerASelfSkipped);
    expect(outcome.status).toBe(CHECK_STATUS.SKIP);
    expect(outcome.skipReason).toBe(SKIP_REASON.OPTIONAL_DEPENDENCY_ABSENT);
    expect(outcome.observation).toContain('mongosh');
  });

  test('the static NG3 guard still passes under a self-skip — it needs no mongosh', () => {
    expect(classifyLayerAOutcomeFor('COMPOSE-UNCHANGED-12', layerASelfSkipped)).toEqual({
      status: CHECK_STATUS.PASS,
    });
  });

  test('a non-zero exit is a fail whose observation admits it cannot attribute per id', () => {
    const outcome = classifyLayerAOutcomeFor('GRANT-SHAPE-01', layerAFailed);
    expect(outcome.status).toBe(CHECK_STATUS.FAIL);
    expect(outcome.observation).toContain('exited 1');
    expect(outcome.observation).toContain('cannot attribute');
  });
});

describe('buildEarlyRunOutcomes — every catalog id gets a record, none of them a vacuous pass', () => {
  test('with a passing Layer A: backend-lane ids pass, every Layer B id is a not-executed skip', () => {
    const outcomes = buildEarlyRunOutcomes({ layerA: layerAPassed });

    // Complete by construction: no id vanishes, because a vanished id is how "no failures reported"
    // gets misread as "everything passed".
    expect(Object.keys(outcomes).sort()).toEqual([...CHECK_IDS].sort());

    for (const id of BACKEND_LANE_IDS) {
      expect(outcomes[id].status).toBe(CHECK_STATUS.PASS);
    }
    for (const id of LAYER_B_IDS) {
      expect(outcomes[id].status).toBe(CHECK_STATUS.SKIP);
      expect(outcomes[id].skipReason).toBe(SKIP_REASON.NOT_EXECUTED);
    }
  });

  test('the unreached ids use the not-executed reason, which is NOT an enumerated benign skip', () => {
    // This is the mechanism that makes an unreached check block exit 0 instead of reading as an
    // accounted-for absence. Asserted by membership rather than prose.
    expect(ENUMERATED_SKIP_REASONS).not.toContain(SKIP_REASON.NOT_EXECUTED);
  });

  test('with no Layer A at all (a failure before stage 1) the backend-lane ids are unreached too', () => {
    const outcomes = buildEarlyRunOutcomes({ layerA: null });
    for (const id of CHECK_IDS) {
      expect(outcomes[id].status).toBe(CHECK_STATUS.SKIP);
      expect(outcomes[id].skipReason).toBe(SKIP_REASON.NOT_EXECUTED);
      // And the observation says where the run actually stopped. Claiming these "never ran against a
      // topology" would understate a run that never reached stage 1 either.
      expect(outcomes[id].observation).toContain('before stage 1');
    }
  });
});

describe('buildEarlyRunReport — a setup-failure run reports honestly', () => {
  test('it records Layer A\u2019s pass AND still exits non-zero (Req 5.9)', () => {
    const { json, outcome } = buildEarlyRunReport({
      setupFailure: bringupFailure(),
      layerA: layerAPassed,
      profile: 'split',
      startedAt: '2024-01-01T00:00:00.000Z',
    });

    // Layer A's twelve ids are preserved rather than discarded — the point of the change.
    expect(outcome.executedCount).toBe(12);
    expect(outcome.tally[CHECK_STATUS.PASS]).toBe(12);

    // And the run is still a failure. A topology that never came up decided nothing about Layer B.
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.hasSetupFailure).toBe(true);
    expect(json.outcome.ok).toBe(false);
  });

  test('no unexecuted check reads as passed (Req 5.10)', () => {
    const { json } = buildEarlyRunReport({
      setupFailure: bringupFailure(),
      layerA: layerAPassed,
    });
    for (const id of LAYER_B_IDS) {
      expect(json.checks[id].status).toBe(CHECK_STATUS.SKIP);
      expect(json.checks[id].status).not.toBe(CHECK_STATUS.PASS);
      expect(json.checks[id].skipReason).toBe(SKIP_REASON.NOT_EXECUTED);
      // A skip must say why it did not run; a report that says a check did not run without saying why
      // is the opaque outcome Req 5.3 forbids.
      expect(json.checks[id].observation).toMatch(/not executed/i);
    }
  });

  test('the setup failure itself is legible — the report cannot read as a successful run', () => {
    const failure = bringupFailure();
    const { json, text } = buildEarlyRunReport({ setupFailure: failure, layerA: layerAPassed });

    expect(json.setupFailure).toMatchObject({
      kind: SETUP_FAILURE_KINDS.BRINGUP_CONTAINER_FAILED,
      service: 'auth-surface',
    });
    // The human summary leads with FAIL and carries the failure's own section, so twelve PASS lines
    // above it cannot be mistaken for a green run.
    expect(text).toContain('FAIL (exit 1)');
    expect(text).toContain(`SETUP FAILURE [${SETUP_FAILURE_KINDS.BRINGUP_CONTAINER_FAILED}]`);
    expect(text).toContain('harness-auth-surface');
  });

  test('a Layer A failure is a CHECK failure, not a setup failure — the two stay distinct', () => {
    // Property 9: a falsified property and a topology that never came up mean different things, so a
    // run that ended on Layer A's verdict carries no run-level setupFailure.
    const { json, outcome } = buildEarlyRunReport({ layerA: layerAFailed });

    expect(json.setupFailure).toBeNull();
    expect(outcome.hasCheckFailure).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.tally[CHECK_STATUS.FAIL]).toBe(12);
  });

  test('a run that reached nothing at all still cannot exit 0', () => {
    // Every record a skip, no setup failure recorded: the `nothingExecuted` clause is what keeps this
    // from reading as a clean all-pass.
    const { outcome } = buildEarlyRunReport({ layerA: null });
    expect(outcome.executedCount).toBe(0);
    expect(outcome.nothingExecuted).toBe(true);
    expect(outcome.ok).toBe(false);
  });
});

describe('the tested-image block in the early-exit report (Req 5.12)', () => {
  test('a setup failure AFTER image resolution carries the image block', () => {
    // A bad MONGO_URI or a bring-up timeout still tested a resolved image, so the block is present —
    // "including on a run that later ends in the setup failure" (Req 5.12).
    const { json, text } = buildEarlyRunReport({
      setupFailure: bringupFailure(),
      layerA: layerAPassed,
      image: imageRecord,
    });
    expect(json.image).toEqual(imageRecord);
    expect(text).toContain(imageRecord.reference);
    expect(text).toContain(imageRecord.id);
    expect(text).toContain(imageRecord.createdAt);
    expect(text).toContain('reused');
  });

  test('a failure BEFORE image resolution omits the block cleanly (image is null)', () => {
    // No image was resolved, so there is nothing tested to name — the block is null, not a fabricated
    // record, and the text prints no Image line.
    const { json, text } = buildEarlyRunReport({
      setupFailure: bringupFailure(),
      layerA: null,
    });
    expect(json.image).toBeNull();
    expect(text).not.toContain('Image:');
  });

  test('writeEarlyRunReport threads the image block onto the artifact it writes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-report-'));
    const reportPath = path.join(dir, 'run-report.json');
    await writeEarlyRunReport({
      setupFailure: bringupFailure(),
      layerA: layerAPassed,
      image: imageRecord,
      reportPath,
      stdout: { write() {} },
    });
    const onDisk = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(onDisk.image).toEqual(imageRecord);
  });
});

describe('serializeRun — the top-level image block (Req 5.12)', () => {
  const oneRecord = () => buildRecords({ 'RUN-REPORT-32': { status: CHECK_STATUS.PASS } });

  test('an image record becomes the top-level image block in JSON and renders in text', () => {
    const { json, text } = serializeRun(oneRecord(), {
      profile: 'split',
      startedAt: '2024-01-01T00:00:10.000Z',
      image: imageRecord,
    });
    // Top-level, beside profile and startedAt.
    expect(json.image).toEqual({
      reference: imageRecord.reference,
      id: imageRecord.id,
      createdAt: imageRecord.createdAt,
      provenance: imageRecord.provenance,
    });
    // All four fields rendered in the human text.
    expect(text).toContain(imageRecord.reference);
    expect(text).toContain(imageRecord.id);
    expect(text).toContain(imageRecord.createdAt);
    expect(text).toContain('reused');
  });

  test('no image record makes the image key null (chosen over omission for a uniform shape)', () => {
    const { json, text } = serializeRun(oneRecord(), { profile: 'split' });
    // The key is present and null, per the documented choice — not absent.
    expect(json).toHaveProperty('image', null);
    expect(text).not.toContain('Image:');
  });

  test('the image block reads only the four reported fields, not a richer object', () => {
    const { json } = serializeRun(oneRecord(), {
      profile: 'split',
      image: { ...imageRecord, secretWorkingField: 'must not leak' },
    });
    expect(Object.keys(json.image).sort()).toEqual(['createdAt', 'id', 'provenance', 'reference']);
  });
});

describe('writeEarlyRunReport — the artifact a run that ended early still leaves', () => {
  test('it writes the JSON a stage-11 reporter would have written', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-report-'));
    const reportPath = path.join(dir, 'run-report.json');
    const stdout = { write() {} };

    const result = await writeEarlyRunReport({
      setupFailure: bringupFailure(),
      layerA: layerAPassed,
      profile: 'split',
      startedAt: '2024-01-01T00:00:00.000Z',
      reportPath,
      stdout,
    });

    const onDisk = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(onDisk.schema).toBe('container-split-run-report/1');
    expect(onDisk.profile).toBe('split');
    expect(onDisk.startedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(onDisk.outcome.exitCode).toBe(1);
    expect(Object.keys(onDisk.checks).sort()).toEqual([...CHECK_IDS].sort());
    expect(result.reportPath).toBe(reportPath);
  });

  test('a write failure never masks the failure the report was describing', async () => {
    const stderr = {
      lines: [],
      write(line) {
        this.lines.push(line);
      },
    };
    const write = async () => {
      throw new Error('disk full');
    };

    const result = await writeEarlyRunReportSafely(
      { setupFailure: bringupFailure(), layerA: layerAPassed, write, stdout: { write() {} } },
      { stderr },
    );

    expect(result).toBeNull();
    expect(stderr.lines.join('')).toContain('Could not write the early-exit run report');
  });
});

describe('validateWrittenRunReport — the half of RUN-REPORT-32 no check can decide', () => {
  // RUN-REPORT-32 cannot assert that its own run wrote an artifact: reporter.mjs writes it from
  // `onRunComplete`, after every test has finished. The observation moved to the runner, immediately
  // after stage 11 returns, which is the first moment the file exists — and these tests pin what the
  // runner does with it. `read` is injected, so nothing here touches the real artifact.

  // A complete, internally consistent report: every catalog id present, all passing.
  const fullReport = (over = {}) => {
    const outcomes = Object.fromEntries(CHECK_IDS.map((id) => [id, { status: CHECK_STATUS.PASS }]));
    const { json } = serializeRun(buildRecords(outcomes), {
      profile: 'split',
      startedAt: '2024-01-01T00:00:10.000Z',
    });
    return JSON.stringify({ ...json, ...over }, null, 2);
  };

  test('a complete, consistent artifact validates and carries the report\u2019s own exit code', async () => {
    const verdict = await validateWrittenRunReport({
      read: async () => fullReport(),
      startedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.tally).toContain(`${CHECK_IDS.length} pass`);
  });

  test('a missing artifact is a failure: the run decided things and recorded none of them', async () => {
    const verdict = await validateWrittenRunReport({
      read: async () => {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.reason).toMatch(/left no artifact/);
  });

  test('an artifact predating this run is a survivor, not this run\u2019s result', async () => {
    // The same misreading the run-start deletion exists to prevent, caught from the other end.
    const verdict = await validateWrittenRunReport({
      read: async () => fullReport({ startedAt: '2023-06-01T00:00:00.000Z' }),
      startedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/before this run started/);
  });

  test('an incomplete artifact fails — a vanished id is how "no failures" reads as "all passed"', async () => {
    const report = JSON.parse(fullReport());
    delete report.checks['TOPO-YAML-15'];
    const verdict = await validateWrittenRunReport({
      read: async () => JSON.stringify(report),
      startedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/TOPO-YAML-15/);
  });

  test('a malformed artifact fails rather than being read as a clean run', async () => {
    const verdict = await validateWrittenRunReport({ read: async () => '{ not json' });
    expect(verdict.ok).toBe(false);
    expect(verdict.exitCode).toBe(1);
  });

  test('a non-enumerated skip makes the report non-zero even though no test failed', async () => {
    // The exit-honesty hole this validation closes: a check that registered no result fails no Jest
    // test, so Jest exits 0 while the report says exit 1. The runner folds the REPORT'S exit code in,
    // so the run agrees with its own artifact.
    const outcomes = Object.fromEntries(
      CHECK_IDS.map((id) => [
        id,
        id === 'PATH-GROUPSYNC-26'
          ? {
              status: CHECK_STATUS.SKIP,
              observation: 'not executed this run',
              skipReason: SKIP_REASON.NOT_EXECUTED,
            }
          : { status: CHECK_STATUS.PASS },
      ]),
    );
    const { json } = serializeRun(buildRecords(outcomes), {
      profile: 'split',
      startedAt: '2024-01-01T00:00:10.000Z',
    });
    const verdict = await validateWrittenRunReport({
      read: async () => JSON.stringify(json),
      startedAt: '2024-01-01T00:00:00.000Z',
    });
    // The artifact is well-formed and honest, so the validation passes…
    expect(verdict.ok).toBe(true);
    // …and the exit code it carries is non-zero, which is what the runner adopts.
    expect(verdict.exitCode).not.toBe(0);
  });
});

describe('the Layer A hand-off to the stage-11 reporter', () => {
  // Layer A decides twelve catalog ids in the api workspace and never registers a result in the Layer B
  // aggregate. Before the hand-off the stage-11 reporter derived all twelve as
  // `skip / optional-dependency-absent`, so a run whose Layer A passed 135 tests with `mongosh` present
  // produced an artifact stating twelve checks did not run for want of `mongosh`.

  test('runLayerBChecks carries Layer A\u2019s summary in the environment, not its stderr', async () => {
    const calls = [];
    const exec = async (command, args, opts) => {
      calls.push({ command, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    await runLayerBChecks({
      exec,
      contextFile: '/tmp/harness-context.json',
      profile: 'split',
      layerA: { status: 0, stdout: '', stderr: 'a very long jest log' },
    });
    const handed = JSON.parse(calls[0].opts.env[LAYER_A_RESULT_ENV]);
    expect(handed).toEqual({ status: 0, selfSkipped: false });
    // The suite's log does not cross the boundary; only the two facts the classification reads do.
    expect(calls[0].opts.env[LAYER_A_RESULT_ENV]).not.toContain('jest log');
  });

  test('the self-skip marker survives the hand-off, so a skip cannot become a pass', async () => {
    const calls = [];
    const exec = async (command, args, opts) => {
      calls.push({ command, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    await runLayerBChecks({
      exec,
      contextFile: '/tmp/harness-context.json',
      profile: 'split',
      layerA: layerASelfSkipped,
    });
    const handed = readLayerASummary({
      [LAYER_A_RESULT_ENV]: calls[0].opts.env[LAYER_A_RESULT_ENV],
    });
    expect(handed).toEqual({ status: 0, selfSkipped: true });
    // And the classification off that summary is the same one the early-exit report makes.
    expect(classifyLayerAOutcomeFor('GRANT-SHAPE-01', handed).skipReason).toBe(
      SKIP_REASON.OPTIONAL_DEPENDENCY_ABSENT,
    );
  });

  test('with no hand-off the reporter claims no knowledge of Layer A rather than inventing a cause', () => {
    expect(readLayerASummary({})).toBeNull();
    expect(readLayerASummary({ [LAYER_A_RESULT_ENV]: 'not json' })).toBeNull();
  });

  test('runLayerBChecks carries the tested-image record in the environment (Req 5.12)', async () => {
    const calls = [];
    const exec = async (command, args, opts) => {
      calls.push({ command, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    await runLayerBChecks({
      exec,
      contextFile: '/tmp/harness-context.json',
      profile: 'split',
      layerA: layerAPassed,
      image: imageRecord,
    });
    // The record crosses through the same channel Layer A's verdict does, so the stage-11 reporter can
    // write the top-level `image` block.
    expect(readImageRecord({ [IMAGE_RECORD_ENV]: calls[0].opts.env[IMAGE_RECORD_ENV] })).toEqual(
      imageRecord,
    );
  });

  test('runLayerBChecks sets no image env var when no image was resolved', async () => {
    const calls = [];
    const exec = async (command, args, opts) => {
      calls.push({ command, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    await runLayerBChecks({
      exec,
      contextFile: '/tmp/harness-context.json',
      profile: 'split',
      layerA: layerAPassed,
      image: null,
    });
    expect(calls[0].opts.env[IMAGE_RECORD_ENV]).toBeUndefined();
  });

  test('the stage-11 reporter writes the top-level image block from the handed-over record', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-reporter-'));
    const reportPath = path.join(dir, 'run-report.json');
    const reporter = new ContainerSplitReporter(
      {},
      {
        reportPath,
        profile: 'split',
        layerA: { status: 0, selfSkipped: false },
        image: imageRecord,
      },
    );
    await reporter.onRunComplete(
      {},
      {
        testResults: [
          {
            testResults: [
              { status: 'passed', fullName: 'topology [TOPO-YAML-15] librechat.yaml is identical' },
            ],
          },
        ],
      },
    );
    const onDisk = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(onDisk.image).toEqual(imageRecord);
  });

  test('the stage-11 reporter writes a null image block when no record was handed over', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-reporter-'));
    const reportPath = path.join(dir, 'run-report.json');
    // The contract under test is the reporter's documented fallback,
    // `options.image ?? readImageRecord(process.env)`: with NO `image` option AND no record in the
    // environment, the reporter claims none. `readImageRecord` reads IMAGE_RECORD_ENV, so this test
    // must delete that key first — a LIVE harness run exports it into the Layer B Jest process before
    // spawning it (run.mjs), and this in-process unit test would otherwise inherit a real record and
    // read it back. Save-and-restore around the construction so no sibling test sees a changed env.
    const priorImageRecord = process.env[IMAGE_RECORD_ENV];
    delete process.env[IMAGE_RECORD_ENV];
    try {
      const reporter = new ContainerSplitReporter(
        {},
        { reportPath, profile: 'split', layerA: { status: 0, selfSkipped: false } },
      );
      await reporter.onRunComplete(
        {},
        {
          testResults: [
            {
              testResults: [
                {
                  status: 'passed',
                  fullName: 'topology [TOPO-YAML-15] librechat.yaml is identical',
                },
              ],
            },
          ],
        },
      );
      const onDisk = JSON.parse(await readFile(reportPath, 'utf8'));
      expect(onDisk.image).toBeNull();
    } finally {
      if (priorImageRecord === undefined) {
        delete process.env[IMAGE_RECORD_ENV];
      } else {
        process.env[IMAGE_RECORD_ENV] = priorImageRecord;
      }
    }
  });

  test('the stage-11 reporter records Layer A\u2019s real outcome for the twelve backend-lane ids', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-reporter-'));
    const reportPath = path.join(dir, 'run-report.json');
    const reporter = new ContainerSplitReporter(
      {},
      { reportPath, profile: 'split', layerA: { status: 0, selfSkipped: false } },
    );
    // An aggregate carrying one Layer B result, the way Jest hands one over.
    await reporter.onRunComplete(
      {},
      {
        testResults: [
          {
            testResults: [
              { status: 'passed', fullName: 'topology [TOPO-YAML-15] librechat.yaml is identical' },
            ],
          },
        ],
      },
    );
    const onDisk = JSON.parse(await readFile(reportPath, 'utf8'));
    for (const id of BACKEND_LANE_IDS) {
      expect(onDisk.checks[id].status).toBe(CHECK_STATUS.PASS);
      // The false statement this fixes: a passing Layer A recorded as skipped for an absent dependency.
      expect(onDisk.checks[id].skipReason).toBeNull();
    }
  });

  test('a Layer A self-skip is still recorded as a skip, so a missing mongosh is not a pass', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-reporter-'));
    const reportPath = path.join(dir, 'run-report.json');
    const reporter = new ContainerSplitReporter(
      {},
      { reportPath, profile: 'split', layerA: { status: 0, selfSkipped: true } },
    );
    await reporter.onRunComplete({}, { testResults: [] });
    const onDisk = JSON.parse(await readFile(reportPath, 'utf8'));
    // The grant suites asserted nothing…
    expect(onDisk.checks['GRANT-SHAPE-01'].status).toBe(CHECK_STATUS.SKIP);
    expect(onDisk.checks['GRANT-SHAPE-01'].skipReason).toBe(SKIP_REASON.OPTIONAL_DEPENDENCY_ABSENT);
    // …while the static NG3 guard needs no mongosh and did run inside that same zero exit.
    expect(onDisk.checks['COMPOSE-UNCHANGED-12'].status).toBe(CHECK_STATUS.PASS);
  });
});

describe('the undecided signal — a check that ran and could not observe its property', () => {
  test('a failed assertion carrying the signal is recorded as a skip, never as a falsified property', () => {
    const outcome = outcomeFromAssertion({
      status: 'failed',
      fullName: 'BOOT-NOWRITE-23 [BOOT-NOWRITE-23] counts zero writes',
      failureMessages: [
        formatUndecided(
          SKIP_REASON.OBSERVATION_UNUSABLE,
          'the boot-window anchor is absent from system.profile.',
        ),
      ],
    });
    expect(outcome.status).toBe(CHECK_STATUS.SKIP);
    expect(outcome.skipReason).toBe(SKIP_REASON.OBSERVATION_UNUSABLE);
    expect(outcome.observation).toMatch(/anchor is absent/);
  });

  test('an ordinary assertion failure is still a fail', () => {
    const outcome = outcomeFromAssertion({
      status: 'failed',
      fullName: 'x [TOPO-YAML-15] y',
      failureMessages: ['expect(received).toBe(expected)'],
    });
    expect(outcome.status).toBe(CHECK_STATUS.FAIL);
  });

  test('an unrecognized reason tag is not honored — it stays a fail', () => {
    const outcome = outcomeFromAssertion({
      status: 'failed',
      fullName: 'x [TOPO-YAML-15] y',
      failureMessages: [formatUndecided('because-i-said-so', 'nope')],
    });
    expect(outcome.status).toBe(CHECK_STATUS.FAIL);
  });

  // OBSERVATION_UNUSABLE is the only undecided reason left: COLLAPSED_RUN_ABSENT was removed with
  // PARITY-COLLAPSE-29's cross-run digest comparison (design NG9 — Req 4.2 is decided structurally),
  // so nothing can emit it and the tag is gone from SKIP_REASON.
  test('the undecided reason does not license exit 0, even beside a passing check', () => {
    const reason = SKIP_REASON.OBSERVATION_UNUSABLE;
    expect(ENUMERATED_SKIP_REASONS).not.toContain(reason);
    const records = buildRecords({
      'TOPO-YAML-15': { status: CHECK_STATUS.PASS },
      'BOOT-NOWRITE-23': {
        status: CHECK_STATUS.SKIP,
        observation: 'undecided',
        skipReason: reason,
      },
    });
    const outcome = runOutcome(records);
    expect(outcome.ok).toBe(false);
    expect(outcome.nonEnumeratedSkipIds).toContain('BOOT-NOWRITE-23');
  });
});

// ---------------------------------------------------------------------------------------------
// The per-path outcomes PATH-EXERCISE-25 carries below its own status (task 11.1). The check covers
// twenty-six paths and Requirements 3.12, 3.13, 3.19 and 3.20 each ask for an outcome distinct from a
// pass, so those live in a SECOND FIELD on the record — never in the check-level `status`, which stays
// pass/fail/skip so the catalog-derived report and the exit-0 gate are untouched.
//
// Three things are asserted here, and each is a way the artifact could lie: an outcome carried with no
// reason (under-reporting Req 5.3 forbids), a passing check whose `undecided` paths vanished into an
// aggregate green, and a previous run's outcomes decorating a check that did not run this time.
// ---------------------------------------------------------------------------------------------
describe('per-path outcomes on the check record', () => {
  const outcome = (over) => ({
    path: '/api/config',
    attributedTo: 'auth-surface',
    httpStatus: 200,
    windowClean: true,
    outcome: PATH_OUTCOME.PASS,
    reason: null,
    ...over,
  });
  const undecidedPath = outcome({
    path: '/oauth/google',
    httpStatus: 500,
    outcome: PATH_OUTCOME.UNDECIDED,
    reason: 'Unconfigured_Provider `google`: grant sufficiency is UNDECIDED for /oauth/google.',
  });

  test('the record carries the outcomes, and the check status stays the three-value vocabulary', () => {
    const [record] = buildRecords({
      'PATH-EXERCISE-25': {
        status: CHECK_STATUS.PASS,
        pathOutcomes: [outcome({}), undecidedPath],
      },
    });
    expect(record.status).toBe(CHECK_STATUS.PASS);
    expect(record.pathOutcomes).toHaveLength(2);
    expect(record.pathOutcomes[1].outcome).toBe(PATH_OUTCOME.UNDECIDED);
    // Exactly the six recorded fields — a producer's working fields do not leak into the data model.
    expect(Object.keys(record.pathOutcomes[0]).sort()).toEqual([
      'attributedTo',
      'httpStatus',
      'outcome',
      'path',
      'reason',
      'windowClean',
    ]);
    // Every other record keeps the shape it had: the field appears only where outcomes were reported.
    const [plain] = buildRecords({ 'TOPO-YAML-15': { status: CHECK_STATUS.PASS } });
    expect(plain.pathOutcomes).toBeUndefined();
  });

  test('an outcome other than `pass` with no reason is rejected where the record is built', () => {
    expect(() =>
      buildRecords({
        'PATH-EXERCISE-25': {
          status: CHECK_STATUS.FAIL,
          observation: 'a path was understated',
          pathOutcomes: [outcome({ outcome: PATH_OUTCOME.UNDERSTATED, reason: '' })],
        },
      }),
    ).toThrow(/requires a reason/);
    // And an outcome with no window scan is not an outcome at all: the scan is what decides grant
    // sufficiency, so a record without it would be a verdict reached without the deciding observation.
    expect(() =>
      buildRecords({
        'PATH-EXERCISE-25': {
          status: CHECK_STATUS.PASS,
          pathOutcomes: [{ ...outcome({}), windowClean: undefined }],
        },
      }),
    ).toThrow(/windowClean/);
  });

  test('a passing check still reports every path, so `undecided` does not disappear into the green', () => {
    const records = buildRecords({
      'PATH-EXERCISE-25': {
        status: CHECK_STATUS.PASS,
        pathOutcomes: [outcome({}), undecidedPath],
      },
    });
    const { text, json } = serializeRun(records, { profile: 'split' });
    expect(text).toContain('1 pass, 0 understated, 0 uncorroborated, 1 undecided');
    expect(text).toContain('/oauth/google');
    expect(text).toMatch(/reason: Unconfigured_Provider/);
    // The machine artifact carries the same list the text rendered.
    expect(json.checks['PATH-EXERCISE-25'].pathOutcomes).toHaveLength(2);
  });

  test('the sidecar is consumed once, so no later run can inherit a previous run\u2019s outcomes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-path-outcomes-'));
    const filePath = path.join(dir, 'path-outcomes.json');

    await publishPathOutcomes('PATH-EXERCISE-25', [outcome({}), undecidedPath], { filePath });
    const first = await consumePublishedPathOutcomes({ filePath });
    expect(first.problems).toEqual([]);
    expect(first.payload.checkId).toBe('PATH-EXERCISE-25');
    expect(first.payload.pathOutcomes).toHaveLength(2);
    // Read AND unlinked: a second consume finds nothing rather than the same payload again. Null is
    // ABSENT — the one finding that is legitimate and silent.
    expect(await consumePublishedPathOutcomes({ filePath })).toBeNull();
    // A malformed list is refused at publish time rather than written for the reporter to trust.
    await expect(
      publishPathOutcomes(
        'PATH-EXERCISE-25',
        [outcome({ outcome: PATH_OUTCOME.UNCORROBORATED, reason: null })],
        { filePath },
      ),
    ).rejects.toThrow(/requires a reason/);
  });

  test('the reporter folds a published payload onto a check that ran, and never onto one that did not', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-reporter-outcomes-'));
    const filePath = path.join(dir, 'path-outcomes.json');
    const ran = path.join(dir, 'ran.json');
    const didNot = path.join(dir, 'did-not.json');

    // The check ran this invocation: the payload lands on its record.
    await publishPathOutcomes('PATH-EXERCISE-25', [outcome({}), undecidedPath], { filePath });
    await new ContainerSplitReporter(
      {},
      { reportPath: ran, pathOutcomesPath: filePath, layerA: { status: 0, selfSkipped: false } },
    ).onRunComplete(
      {},
      {
        testResults: [
          {
            testResults: [
              {
                status: 'passed',
                fullName: 'PATH-EXERCISE-25: … [PATH-EXERCISE-25] every routed path is exercised',
              },
            ],
          },
        ],
      },
    );
    const withOutcomes = JSON.parse(await readFile(ran, 'utf8'));
    expect(withOutcomes.checks['PATH-EXERCISE-25'].status).toBe(CHECK_STATUS.PASS);
    expect(withOutcomes.checks['PATH-EXERCISE-25'].pathOutcomes).toHaveLength(2);

    // A sidecar left behind by a crashed run must not decorate the derived `skip` of a check that never
    // executed. A report attaching an earlier run's per-path outcomes to a check that did not run is a
    // false statement in the artifact, which is worse than an absent one.
    await publishPathOutcomes('PATH-EXERCISE-25', [outcome({})], { filePath });
    await new ContainerSplitReporter(
      {},
      { reportPath: didNot, pathOutcomesPath: filePath, layerA: { status: 0, selfSkipped: false } },
    ).onRunComplete({}, { testResults: [] });
    const derived = JSON.parse(await readFile(didNot, 'utf8'));
    expect(derived.checks['PATH-EXERCISE-25'].status).toBe(CHECK_STATUS.SKIP);
    expect(derived.checks['PATH-EXERCISE-25'].skipReason).toBe(SKIP_REASON.NOT_EXECUTED);
    expect(derived.checks['PATH-EXERCISE-25'].pathOutcomes).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // The three ways the per-path table went missing from a PASSING check's record, each asserted
  // where it broke. A live split run produced PATH-EXERCISE-25 with `status: "pass"`,
  // `observation: null` and NO `pathOutcomes` key, so five `undecided` Unconfigured_Provider paths
  // were invisible in the artifact — the exact failure this channel exists to prevent.
  // -------------------------------------------------------------------------------------------

  test('a LIVE-SHAPED payload survives publish -> consume -> record -> summary', async () => {
    // Built from the real decision rule and the real list summary, not from literals: a channel that
    // round-trips a hand-written entry while dropping what `classifyExercise` actually produces is a
    // channel that passes its own test and loses the run's outcomes.
    const observation = (over) => ({
      path: '/api/config',
      surface: 'config',
      attributedTo: AUTH_SURFACE_UPSTREAM,
      httpStatus: 200,
      windowScanned: true,
      windowClean: true,
      authorizationError: null,
      transportError: null,
      scanError: null,
      ...over,
    });
    const decisions = [];
    for (let i = 0; i < 21; i += 1) {
      decisions.push(classifyExercise({ observation: observation({ path: `/api/p${i}` }) }));
    }
    // The five `/oauth/<provider>` paths a run with no social provider configured narrows, which is
    // the live shape: a PASSING check whose five `undecided` entries are the whole point of the table.
    const providers = ['apple', 'discord', 'facebook', 'github', 'google'];
    for (const provider of providers) {
      decisions.push(
        classifyExercise({
          observation: observation({
            path: `/oauth/${provider}`,
            surface: `${provider} login`,
            httpStatus: 500,
          }),
          undecidedReason: `Unconfigured_Provider \`${provider}\`: no strategy is registered.`,
        }),
      );
    }
    const summary = summarizePathExercise(decisions);
    expect(summary.verdict).toBe('pass');
    expect(summary.pathOutcomes).toHaveLength(26);

    const dir = await mkdtemp(path.join(tmpdir(), 'harness-live-shape-'));
    const filePath = path.join(dir, 'path-outcomes.json');
    await publishPathOutcomes('PATH-EXERCISE-25', summary.pathOutcomes, { filePath });
    const consumed = await consumePublishedPathOutcomes({ filePath });

    // Nothing is dropped between the two validations: the publisher validates the RAW list and writes
    // the NORMALIZED one, so a normalization the validator would reject is a silent loss.
    expect(consumed.problems).toEqual([]);
    expect(consumed.payload.pathOutcomes).toHaveLength(26);
    const undecidedEntries = consumed.payload.pathOutcomes.filter(
      (entry) => entry.outcome === PATH_OUTCOME.UNDECIDED,
    );
    expect(undecidedEntries).toHaveLength(5);
    expect(undecidedEntries.map((entry) => entry.path).sort()).toEqual(
      providers.map((provider) => `/oauth/${provider}`).sort(),
    );
    for (const entry of undecidedEntries) {
      expect(entry.reason).toMatch(/Unconfigured_Provider/);
    }

    // And all the way onto the record and into both renderings, on a PASS.
    const records = buildRecords({
      'PATH-EXERCISE-25': {
        status: CHECK_STATUS.PASS,
        pathOutcomes: consumed.payload.pathOutcomes,
      },
    });
    const { json, text } = serializeRun(records, { profile: 'split' });
    expect(json.checks['PATH-EXERCISE-25'].pathOutcomes).toHaveLength(26);
    expect(text).toContain('21 pass, 0 understated, 0 uncorroborated, 5 undecided');
    expect(text).toContain('/oauth/apple');
  });

  test('a sidecar that is PRESENT and unusable is a finding, not an absence', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-unusable-sidecar-'));
    const filePath = path.join(dir, 'path-outcomes.json');
    // The asymmetry class: a producer writes an entry the consumer's validator rejects. Before this,
    // consume unlinked the file and returned null — indistinguishable from "no live exercise ran".
    await writeFile(
      filePath,
      `${JSON.stringify({
        schema: 'container-split-path-outcomes/1',
        checkId: 'PATH-EXERCISE-25',
        publishedAt: new Date().toISOString(),
        pathOutcomes: [{ ...undecidedPath, reason: null }],
      })}\n`,
      'utf8',
    );

    const consumed = await consumePublishedPathOutcomes({ filePath });
    expect(consumed).not.toBeNull();
    expect(consumed.payload).toBeNull();
    expect(consumed.problems.join(' ')).toMatch(/requires a reason/);
    // The diagnostic can still name what was written, and the anti-staleness guarantee is unchanged:
    // the file is gone whether it was usable or not, so no later run inherits it.
    expect(consumed.excerpt).toContain('/oauth/google');
    await expect(stat(filePath)).rejects.toThrow();

    // Unparseable text is the same class of finding, not an absence either.
    await writeFile(filePath, 'not json at all', 'utf8');
    const garbled = await consumePublishedPathOutcomes({ filePath });
    expect(garbled.payload).toBeNull();
    expect(garbled.problems.join(' ')).toMatch(/not valid JSON/);

    // Only a file that is not there is null.
    expect(await consumePublishedPathOutcomes({ filePath })).toBeNull();
  });

  test('the reporter is LOUD about an unusable sidecar rather than writing a green record with no table', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-loud-sidecar-'));
    const filePath = path.join(dir, 'path-outcomes.json');
    const reportPath = path.join(dir, 'run-report.json');
    await writeFile(
      filePath,
      `${JSON.stringify({
        schema: 'container-split-path-outcomes/1',
        checkId: 'PATH-EXERCISE-25',
        publishedAt: new Date().toISOString(),
        pathOutcomes: [{ ...undecidedPath, reason: null }],
      })}\n`,
      'utf8',
    );

    // The streams are captured by swapping `write`, not with `jest.spyOn`: this suite runs under native
    // ESM (jest.config.mjs's `transform: {}`), where Jest injects no `jest` global.
    const captured = { stderr: [], stdout: [] };
    const original = { stderr: process.stderr.write, stdout: process.stdout.write };
    process.stderr.write = (chunk) => captured.stderr.push(chunk) && true;
    process.stdout.write = (chunk) => captured.stdout.push(chunk) && true;
    try {
      await new ContainerSplitReporter(
        {},
        { reportPath, pathOutcomesPath: filePath, layerA: { status: 0, selfSkipped: false } },
      ).onRunComplete(
        {},
        {
          testResults: [
            {
              testResults: [
                {
                  status: 'passed',
                  fullName: 'PATH-EXERCISE-25: … [PATH-EXERCISE-25] every routed path is exercised',
                },
              ],
            },
          ],
        },
      );

      const onDisk = JSON.parse(await readFile(reportPath, 'utf8'));
      // The check itself is still what Jest decided — nothing about the split was falsified.
      expect(onDisk.checks['PATH-EXERCISE-25'].status).toBe(CHECK_STATUS.PASS);
      // A malformed list is not attached: it throws in buildCheckRecord, and an artifact missing one
      // table beats no artifact at all. What must NOT happen is the table going missing quietly.
      expect(onDisk.checks['PATH-EXERCISE-25'].pathOutcomes).toBeUndefined();
      expect(onDisk.setupFailure.kind).toBe(PATH_OUTCOMES_UNUSABLE_KIND);
      expect(onDisk.setupFailure.message).toMatch(/PRESENT but unusable/);
      expect(onDisk.setupFailure.detail).toContain('/oauth/google');
      // And it blocks the all-clear, for the same reason a setup failure does: the run decided a
      // criterion and did not report it, which no green tally may absorb.
      expect(onDisk.outcome.ok).toBe(false);
      expect(onDisk.outcome.exitCode).toBe(1);

      const stderrText = captured.stderr.join('');
      expect(stderrText).toContain(PATH_OUTCOMES_UNUSABLE_KIND);
      expect(stderrText).toMatch(/requires a reason/);
      const stdoutText = captured.stdout.join('');
      expect(stdoutText).toContain(`SETUP FAILURE [${PATH_OUTCOMES_UNUSABLE_KIND}]`);
      expect(stdoutText).toContain('detail:');
    } finally {
      process.stderr.write = original.stderr;
      process.stdout.write = original.stdout;
    }
  });

  test('only the reporter that writes the canonical report may consume the canonical sidecar', () => {
    // The root cause of the live miss. jest.config.mjs runs this very file in the SAME Jest invocation
    // as checks/path-exercise.spec.mjs, and two tests above construct a reporter with a temp
    // `reportPath` to assert Layer A's hand-off. With the sidecar path defaulting to the canonical one,
    // those reporters read AND UNLINKED the real run's sidecar and dropped it, because the check it
    // belonged to had no result in their synthetic aggregate — so the run's own reporter found nothing.
    //
    // Deliberately asserted through the pure resolver: a test that planted or removed a file at
    // PATH_OUTCOMES_PATH to observe this would be committing the very defect it describes.
    expect(sidecarPathFor({ reportPath: RUN_REPORT_PATH })).toBe(PATH_OUTCOMES_PATH);
    expect(sidecarPathFor({ reportPath: '/tmp/somewhere/run-report.json' })).toBeNull();
    // An explicit override always wins — that is how a test owns both files.
    expect(
      sidecarPathFor({
        reportPath: '/tmp/somewhere/run-report.json',
        pathOutcomesPath: '/tmp/s.json',
      }),
    ).toBe('/tmp/s.json');
    expect(sidecarPathFor({ reportPath: RUN_REPORT_PATH, pathOutcomesPath: '/tmp/s.json' })).toBe(
      '/tmp/s.json',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The catalog's requirement lists (task 11.7). Every check record's `requirements` array is read
// straight out of check-catalog.mjs, so a stale entry is not a cosmetic drift — it is a run that
// decided a criterion and reported nothing about it (Req 5.4). The path-exercise work added eleven
// criteria to one check and one to another, and nothing here re-derives which: the two lists are
// stated and then cross-checked for coverage, so adding a criterion to requirements.md without
// giving it a deciding check fails here rather than silently going unreported.
//
// The vacancies are asserted as vacancies on purpose. Check id 30 and criteria 4.3/4.5 were removed
// with `PARITY-BEHAVIOR-30` (task 12.2) and nothing was renumbered, because the ids are cited by the
// design's negative-control recipes and by test titles. A list that cited 4.3 or 4.5 would claim a
// criterion the spec no longer carries.
// ---------------------------------------------------------------------------------------------
describe('the catalog\u2019s requirement lists', () => {
  // Requirement 3's path-exercise criteria, each of which some check must decide.
  const PATH_EXERCISE_CRITERIA = [
    '3.12',
    '3.13',
    '3.14',
    '3.15',
    '3.16',
    '3.17',
    '3.18',
    '3.19',
    '3.20',
    '3.21',
    '3.22',
  ];

  test('PATH-EXERCISE-25 carries the decision rule, both fixtures and the carve-out', () => {
    const [record] = buildRecords({ 'PATH-EXERCISE-25': { status: CHECK_STATUS.PASS } });
    // The record, not just the table: this is what the run report publishes.
    expect(record.requirements).toEqual([
      '3.4',
      '3.12',
      '3.13',
      '3.14',
      '3.15',
      '3.16',
      '3.17',
      '3.19',
      '3.20',
      '3.21',
      '3.22',
      // 3.23 (task 17.4): a path not recorded as session-gated that answers a clean 401 is a fixture
      // failure — the application now gates it and this check's session table has fallen behind.
      '3.23',
      // 2.11 moved here from the retired allowlist-digest guard (task 17.1): a moved path now
      // surfaces through this check's `understated` outcome rather than a pre-bring-up tripwire.
      '2.11',
    ]);
    // 3.18 is the seed-outside-the-window criterion, and this check does not assert the timing.
    expect(record.requirements).not.toContain('3.18');
  });

  test('BOOT-NOWRITE-23 carries 3.18 — the pre-window seed its write count depends on', () => {
    const [record] = buildRecords({ 'BOOT-NOWRITE-23': { status: CHECK_STATUS.PASS } });
    expect(record.requirements).toEqual(['3.9', '3.18']);
    // 3.9 is NOT orphaned by the removal of the read-only-credential variant (the vacant id 24): this
    // check carries it, and reads `system.profile` rather than depending on the application having
    // logged a refusal it may have swallowed.
    expect(record.requirements).toContain('3.9');
    expect(CHECK_IDS).not.toContain('BOOT-NOWRITE-RO-24');
  });

  test('every path-exercise criterion is decided by at least one check', () => {
    const cited = new Set(CHECK_IDS.flatMap((id) => catalogEntryFor(id).requirements));
    for (const criterion of PATH_EXERCISE_CRITERIA) {
      expect(cited).toContain(criterion);
    }
  });

  test('the vacancies stay vacant: check ids 24 and 30, and criteria 4.3 and 4.5', () => {
    expect(CHECK_IDS).not.toContain('PARITY-BEHAVIOR-30');
    expect(CHECK_IDS.filter((id) => id.endsWith('-30'))).toEqual([]);
    // The surrounding ids kept their numbers rather than closing the gap.
    expect(CHECK_IDS).toContain('PARITY-COLLAPSE-29');
    expect(CHECK_IDS).toContain('PARITY-SUITE-31');

    // Id 24 is vacant on the same precedent: BOOT-NOWRITE-RO-24 was removed (its readiness half passes
    // through a swallowed refusal and its log half rests on BOOT-CLEAN-21's dependency), and nothing was
    // renumbered around it.
    expect(CHECK_IDS.filter((id) => id.endsWith('-24'))).toEqual([]);
    expect(CHECK_IDS).toContain('BOOT-NOWRITE-23');
    expect(CHECK_IDS).toContain('PATH-EXERCISE-25');
    // Req 3.9 is not orphaned by that removal — BOOT-NOWRITE-23 carries it.
    const carrying39 = CHECK_IDS.filter((id) => CHECK_CATALOG[id].requirements.includes('3.9'));
    expect(carrying39).toContain('BOOT-NOWRITE-23');

    for (const [id, entry] of Object.entries(CHECK_CATALOG)) {
      expect({ id, cites: entry.requirements.includes('4.3') }).toEqual({ id, cites: false });
      expect({ id, cites: entry.requirements.includes('4.5') }).toEqual({ id, cites: false });
    }
  });
});
