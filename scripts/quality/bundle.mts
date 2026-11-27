import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type {
  CoverageState,
  MutationSection,
  QualityFindings,
  RiskFile,
  RiskFunction,
  RiskSection,
  Workspace,
} from './findings.mts';

import {
  MAX_ARTIFACT_BYTES,
  MAX_FAILED_TESTS,
  MAX_REASON,
  MAX_TEST_NAME,
  MAX_TEXT,
  SCHEMA,
  fitFindings,
  truncate,
  unavailableMutation,
  unavailableRisk,
  validateFindings,
  writeFindings,
} from './findings.mts';
import { renderSections, resolveHints } from './render.mts';

/** Largest `risk.json` the bundler parses; the API workspace's report is well under 1 MB. */
const MAX_RISK_BYTES = 50_000_000;
const WORKSPACES: Workspace[] = ['data-schemas', 'api', 'server'];

export interface Selection {
  risk: Workspace[];
  mutation: boolean;
}

/** The workspaces `changes.mts` selected, from its `reports` output: `{ workspace, task }[]`. */
export function parseSelection(raw: string): Selection {
  const jobs: unknown = JSON.parse(raw || '[]');
  if (!Array.isArray(jobs)) throw new Error('QUALITY_REPORTS is not a list');
  const risk = new Set<Workspace>();
  let mutation = false;
  for (const job of jobs) {
    const workspace = WORKSPACES.find((name) => name === job?.workspace);
    if (!workspace) throw new Error('QUALITY_REPORTS names an unknown workspace');
    if (job.task?.check === 'risk') risk.add(workspace);
    else if (job.task?.check === 'mutation' && workspace === 'data-schemas') mutation = true;
    else throw new Error('QUALITY_REPORTS names an unknown check');
  }
  return { risk: WORKSPACES.filter((workspace) => risk.has(workspace)), mutation };
}

/** A regular file within `max` bytes, or `undefined` when absent. Never follows a symlink. */
function readFile(path: string, max: number): string | undefined {
  let size: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    size = stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (size > max) throw new Error(`${path} exceeds ${max} bytes`);
  return readFileSync(path, 'utf8');
}

function copyIfPresent(from: string, to: string): boolean {
  try {
    if (!lstatSync(from).isFile()) return false;
  } catch {
    return false;
  }
  copyFileSync(from, to);
  return true;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asText = (value: unknown, max: number): string =>
  typeof value === 'string' ? truncate(value, max) : '';
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const STATES = new Set<string>(['measured', 'incomplete', 'unavailable']);
const asState = (value: unknown): CoverageState | null =>
  typeof value === 'string' && STATES.has(value) ? (value as CoverageState) : null;

const uncovered = (file: RiskFile) =>
  file.gaps.reduce((total, gap) => total + gap.end - gap.start + 1, 0);

/** Maps `run.mts`'s `risk.json` to a findings risk section, or `undefined` when the result does
 * not validate. Files are ordered by uncovered changed lines, then non-measured files, so the byte
 * cap drops measured files with no gap first. */
export function riskSection(
  raw: unknown,
  workspace: Workspace,
  identity: Omit<QualityFindings, 'schema' | 'risk' | 'mutation'>,
): RiskSection | undefined {
  if (!isObject(raw) || !Array.isArray(raw.functions) || !Array.isArray(raw.testGaps)) return;
  const files: RiskFile[] = raw.testGaps.map((value) => {
    const gap = isObject(value) ? value : {};
    return {
      file: asText(gap.file, 500),
      state: asState(gap.state) ?? 'unavailable',
      scope: asText(gap.scope, MAX_REASON),
      reasons: asList(gap.reasons)
        .slice(0, 20)
        .map((reason) => asText(reason, MAX_REASON)),
      gaps: asList(gap.gaps).map((item) => {
        const range = isObject(item) ? item : {};
        return {
          start: range.start as number,
          end: range.end as number,
          excerpt: asText(range.excerpt, MAX_TEXT),
        };
      }),
    };
  });
  const functions: RiskFunction[] = raw.functions.map((value) => {
    const fn = isObject(value) ? value : {};
    return {
      file: asText(fn.file, 500),
      name: asText(fn.function, 200) || '<anonymous>',
      line: fn.line as number,
      column: fn.column as number,
      complexity: fn.complexity as number,
      cognitiveComplexity: fn.cognitiveComplexity as number,
      coverage: asNumber(fn.statementCoverage),
      crap: asNumber(fn.crap),
      state: asState(fn.coverageState),
    };
  });
  files.sort(
    (a, b) =>
      uncovered(b) - uncovered(a) ||
      Number(a.state === 'measured') - Number(b.state === 'measured') ||
      a.file.localeCompare(b.file),
  );
  functions.sort(
    (a, b) => (b.crap ?? -1) - (a.crap ?? -1) || b.complexity - a.complexity || a.line - b.line,
  );
  const section: RiskSection = {
    workspace,
    status: 'complete',
    coverageScope: asText(raw.coverageScope, MAX_REASON),
    summary: {
      files: files.length,
      measured: files.filter((file) => file.state === 'measured').length,
      incomplete: files.filter((file) => file.state === 'incomplete').length,
      unavailable: files.filter((file) => file.state === 'unavailable').length,
      uncoveredLines: files.reduce((total, file) => total + uncovered(file), 0),
    },
    files,
    functions,
    omitted: { files: 0, functions: 0 },
    failure: null,
  };
  const checked = validateFindings(
    fitFindings({ schema: SCHEMA, ...identity, risk: [section], mutation: [] }),
  );
  return checked.ok ? section : undefined;
}

/** Largest `failure.json` the bundler parses; `run.mts` writes at most a few kilobytes. */
const MAX_FAILURE_BYTES = 100_000;

/** Maps `run.mts`'s `failure.json` (written when the workspace's Jest run had failing tests) to a
 * `failed` risk section, or `undefined` when the record does not validate. */
export function failedSection(
  raw: unknown,
  workspace: Workspace,
  identity: Omit<QualityFindings, 'schema' | 'risk' | 'mutation'>,
): RiskSection | undefined {
  if (!isObject(raw) || !Array.isArray(raw.tests)) return;
  const section: RiskSection = {
    ...unavailableRisk(workspace),
    status: 'failed',
    failure: {
      failedTests: raw.failedTests as number,
      failedSuites: raw.failedSuites as number,
      tests: raw.tests.slice(0, MAX_FAILED_TESTS).map((value) => {
        const item = isObject(value) ? value : {};
        return {
          suite: asText(item.suite, 500),
          test: item.test === null ? null : asText(item.test, MAX_TEST_NAME),
        };
      }),
    },
  };
  const checked = validateFindings(
    fitFindings({ schema: SCHEMA, ...identity, risk: [section], mutation: [] }),
  );
  return checked.ok ? section : undefined;
}

/** A manual run has no request base; it uses the merge base its reports were computed from. */
export function discoverBase(
  directory: string,
  head: string,
  selection: Selection,
): string | undefined {
  const sources = [
    ...(selection.mutation
      ? [join(directory, `quality-internal-mutation-data-schemas-${head}`, 'findings.json')]
      : []),
    ...selection.risk.flatMap((workspace) =>
      ['risk.json', 'failure.json'].map((name) =>
        join(directory, `quality-internal-risk-${workspace}-${head}`, name),
      ),
    ),
  ];
  for (const path of sources) {
    try {
      const raw: unknown = JSON.parse(readFile(path, MAX_RISK_BYTES) ?? 'null');
      if (isObject(raw) && typeof raw.base === 'string' && /^[a-f0-9]{40}$/u.test(raw.base))
        return raw.base;
    } catch {
      // Try the next report.
    }
  }
  return undefined;
}

export interface BundleInput {
  /** Holds the downloaded `quality-internal-*` artifacts, one directory each. */
  directory: string;
  output: string;
  repository: string;
  pr: number;
  base: string;
  head: string;
  selection: Selection;
  hints: number;
  repositoryUrl: string;
}

/** Collects the selected workspaces' reports into the `quality-report` layout and returns the
 * findings document as written. A missing or invalid workspace report becomes an `unavailable`
 * section rather than failing the bundle. */
export function bundle(input: BundleInput): QualityFindings {
  const identity = {
    repository: input.repository,
    pr: input.pr,
    base: input.base,
    head: input.head,
  };
  rmSync(input.output, { recursive: true, force: true });
  mkdirSync(join(input.output, 'risk'), { recursive: true });
  mkdirSync(join(input.output, 'mutation'), { recursive: true });
  const risk = input.selection.risk.map((workspace) => {
    const source = join(input.directory, `quality-internal-risk-${workspace}-${input.head}`);
    copyIfPresent(join(source, 'risk.json'), join(input.output, 'risk', `${workspace}.json`));
    copyIfPresent(join(source, 'summary.md'), join(input.output, 'risk', `${workspace}.md`));
    try {
      const text = readFile(join(source, 'risk.json'), MAX_RISK_BYTES);
      const section =
        text === undefined ? undefined : riskSection(JSON.parse(text), workspace, identity);
      if (section) return section;
      console.warn(`Change-risk report for ${workspace} is missing or invalid.`);
    } catch (error) {
      console.warn(
        `Change-risk report for ${workspace} is unreadable: ${(error as Error).message}`,
      );
    }
    try {
      const text = readFile(join(source, 'failure.json'), MAX_FAILURE_BYTES);
      const section =
        text === undefined ? undefined : failedSection(JSON.parse(text), workspace, identity);
      if (section) return section;
      if (text !== undefined) console.warn(`Test failure record for ${workspace} is invalid.`);
    } catch (error) {
      console.warn(
        `Test failure record for ${workspace} is unreadable: ${(error as Error).message}`,
      );
    }
    return unavailableRisk(workspace);
  });
  const mutation: MutationSection[] = [];
  if (input.selection.mutation) {
    const source = join(input.directory, `quality-internal-mutation-data-schemas-${input.head}`);
    const target = join(input.output, 'mutation');
    copyIfPresent(join(source, 'mutation.json'), join(target, 'data-schemas.json'));
    copyIfPresent(join(source, 'mutation.html'), join(target, 'data-schemas.html'));
    copyIfPresent(join(source, 'report.md'), join(target, 'data-schemas.md'));
    let section = unavailableMutation();
    try {
      const text = readFile(join(source, 'findings.json'), MAX_ARTIFACT_BYTES);
      const checked = text === undefined ? undefined : validateFindings(JSON.parse(text), identity);
      if (checked?.ok && checked.value.mutation.length === 1) section = checked.value.mutation[0];
      else
        console.warn(
          `Mutation findings are missing or invalid${checked && !checked.ok ? `: ${checked.error}` : ''}.`,
        );
    } catch (error) {
      console.warn(`Mutation findings are unreadable: ${(error as Error).message}`);
    }
    mutation.push(section);
  }
  const data: QualityFindings = { schema: SCHEMA, ...identity, risk, mutation };
  const written = writeFindings(join(input.output, 'findings.json'), data);
  // report.md renders the unfitted data, so it lists what the byte-capped findings file omits.
  writeFileSync(
    join(input.output, 'report.md'),
    [
      `# Quality report for ${input.head}`,
      '',
      renderSections(data, {
        repositoryUrl: input.repositoryUrl,
        head: input.head,
        budget: Infinity,
        hints: input.hints,
        survivorsPerLine: Infinity,
      }),
    ].join('\n'),
  );
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      output: { type: 'string' },
      repository: { type: 'string' },
      pr: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
    },
  });
  if (!values.directory || !values.output || !values.repository || !values.head)
    throw new Error('Expected --directory, --output, --repository and --head');
  const pr = Number(values.pr ?? '0');
  // 0 means "no pull request" (a manual workflow_dispatch run with nothing to comment on).
  if (!Number.isInteger(pr) || pr < 0) throw new Error('--pr must be a non-negative integer');
  const env = process.env;
  const selection = parseSelection(env.QUALITY_REPORTS ?? '[]');
  const base = values.base || discoverBase(values.directory, values.head, selection);
  if (!base) throw new Error('No --base given and no report records one');
  const input: BundleInput = {
    directory: values.directory,
    output: values.output,
    repository: values.repository,
    pr,
    base,
    head: values.head,
    selection,
    hints: resolveHints(env.QUALITY_REFACTOR_HINTS),
    repositoryUrl: `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${values.repository}`,
  };
  const written = bundle(input);
  const summary = readFileSync(join(input.output, 'report.md'), 'utf8');
  // The job summary holds at most 1 MiB; the artifact keeps the full report either way.
  if (env.GITHUB_STEP_SUMMARY)
    writeFileSync(
      env.GITHUB_STEP_SUMMARY,
      Buffer.byteLength(summary) < 1_000_000
        ? summary
        : 'The quality report exceeds the job summary limit; see `report.md` in the `quality-report` artifact.\n',
      { flag: 'a' },
    );
  console.log(
    `Wrote ${input.output}: ${written.risk.length} change-risk and ${written.mutation.length} mutation sections.`,
  );
}
