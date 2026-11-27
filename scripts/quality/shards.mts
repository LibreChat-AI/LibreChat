import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import type { Mutant, MutationRange } from '@stryker-mutator/api/core';
import type { mutationSelection } from './risk.mts';
import { LoggingIgnorer } from './ignore.mts';

type Target = ReturnType<typeof mutationSelection>[number];

/** Stryker normalizes backslashes as path separators, so use character classes for literals. */
export function mutationPatterns(targets: Target[]): string[] {
  return targets.flatMap(({ file, mutate }) =>
    mutate.map((pattern) => {
      const suffix = /:\d+:\d+-\d+:\d+$/u.exec(pattern)?.[0];
      if (!suffix || file.includes('\\')) throw new Error(`Unsupported mutation path: ${file}`);
      return file.replace(/[*?[\]{}()!+@]/gu, (character) => `[${character}]`) + suffix;
    }),
  );
}
export interface Shard {
  index: number;
  targets: Target[];
  expected: string[];
}
export interface ShardPlan {
  base: string;
  head: string;
  workspace: string;
  digest: string;
  staticMutants: boolean;
  shards: Shard[];
}

const compare = (a: { line: number; column: number }, b: typeof a) =>
  a.line - b.line || a.column - b.column;

/** Counts for a run summary. A shard's target keeps its file's whole changed-function list, so
 * only functions that overlap one of the target's own mutate ranges count (a range can sit in a
 * function or span several whole ones). A file whose ranges are all outside functions
 * (module-level code) counts in `files` but not `functionFiles`. */
export function mutatedScope(targets: Target[]) {
  let functions = 0;
  let functionFiles = 0;
  for (const target of targets) {
    const ranges = target.mutate.map(mutationRange);
    const owners = target.functions.filter(({ location }) => {
      // Function locations are one-based in both line and column; ranges use zero-based lines
      // and columns.
      const start = { line: location.start.line - 1, column: location.start.column - 1 };
      const end = { line: location.end.line - 1, column: location.end.column - 1 };
      return ranges.some((range) => compare(start, range.end) < 0 && compare(range.start, end) < 0);
    });
    functions += owners.length;
    if (owners.length) functionFiles++;
  }
  return { functions, functionFiles, files: targets.length };
}

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? '' : 's'}`;

/** One summary sentence for `mutatedScope`, naming module-level-only files separately. */
export function describeMutatedScope(targets: Target[]): string {
  const { functions, functionFiles, files } = mutatedScope(targets);
  const changed = `Changed functions: ${functions} in ${count(functionFiles, 'file')}.`;
  const outside = files - functionFiles;
  if (!outside) return changed;
  return `${changed} Mutated files: ${files}, of which ${outside} ${outside === 1 ? 'has' : 'have'} changes only outside functions.`;
}

export function mutationRange(pattern: string): MutationRange {
  const match = /:(\d+):(\d+)-(\d+):(\d+)$/u.exec(pattern);
  if (!match) throw new Error(`Invalid mutation range: ${pattern}`);
  return {
    start: { line: Number(match[1]) - 1, column: Number(match[2]) },
    end: { line: Number(match[3]) - 1, column: Number(match[4]) },
  };
}

/** IDs change between Stryker runs. Source locations and replacements identify the mutation. */
export function mutantKey(
  file: string,
  mutant: Pick<Mutant, 'location' | 'mutatorName' | 'replacement'>,
) {
  const { start, end } = mutant.location;
  return JSON.stringify([
    file,
    start.line,
    start.column,
    end.line,
    end.column,
    mutant.mutatorName,
    mutant.replacement,
  ]);
}

/** Inverse of `mutantKey`, for rendering an unfinished mutant's location without a live report. */
export function parseMutantKey(key: string): {
  file: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
  mutatorName: string;
  replacement: string;
} {
  const [file, startLine, startColumn, endLine, endColumn, mutatorName, replacement] =
    JSON.parse(key);
  return {
    file,
    location: {
      start: { line: startLine, column: startColumn },
      end: { line: endLine, column: endColumn },
    },
    mutatorName,
    replacement,
  };
}

/** A reconstructed shard (run.mts, after its worker is killed at the execution-budget deadline)
 * is complete once every planned mutant key was actually finished before the kill; only the final
 * `completion.json` write raced with it. Recording that case as `'partial'` would make merge.mts
 * reject an otherwise-complete shard as incomplete. */
export function isReconstructedShardComplete(expected: string[], finished: Set<string>): boolean {
  return expected.every((key) => finished.has(key));
}

export function assertMutants(expected: string[], actual: string[]) {
  const unique = new Set(actual);
  if (
    new Set(expected).size !== expected.length ||
    unique.size !== actual.length ||
    actual.length !== expected.length ||
    expected.some((key) => !unique.has(key))
  ) {
    throw new Error(
      'Mutation set differs from the shard plan (missing, duplicate, or unexpected mutant)',
    );
  }
}

export async function planShards(
  targets: Target[],
  base: string,
  head: string,
  workspace: string,
  count = 4,
  staticMutants = true,
): Promise<ShardPlan> {
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('Expected 1 to 4 shards');
  const sources = targets.map((target) => ({
    name: resolve(target.file),
    content: readFileSync(target.file, 'utf8'),
    mutate: target.mutate.map(mutationRange),
  }));
  const disabled = () => false;
  const silent = () => {};
  const instrumenter = new Instrumenter({
    isTraceEnabled: disabled,
    isDebugEnabled: disabled,
    isInfoEnabled: disabled,
    isWarnEnabled: disabled,
    isErrorEnabled: disabled,
    isFatalEnabled: disabled,
    trace: silent,
    debug: silent,
    info: silent,
    warn: silent,
    error: silent,
    fatal: silent,
  });
  // Same ignorer the real run loads (./ignore.mts), so a planned mutant's ignored status here
  // matches what the real run reports, keeping the expected and actual mutant sets identical.
  const { mutants } = await instrumenter.instrument(sources, {
    plugins: null,
    ignorers: [new LoggingIgnorer()],
    excludedMutations: [],
  });
  const groups = targets.flatMap((target) =>
    target.mutate.map((pattern) => ({
      file: target.file,
      pattern,
      range: mutationRange(pattern),
      expected: [] as string[],
    })),
  );
  for (const mutant of mutants) {
    const file = relative(process.cwd(), mutant.fileName).replaceAll('\\', '/');
    const owners = groups.filter(
      (group) =>
        group.file === file &&
        compare(group.range.start, mutant.location.start) <= 0 &&
        compare(mutant.location.end, group.range.end) <= 0,
    );
    if (owners.length !== 1) throw new Error(`Mutation must belong to exactly one range: ${file}`);
    // Instrumenter positions are zero-based; JSON report positions are one-based.
    const location = {
      start: { line: mutant.location.start.line + 1, column: mutant.location.start.column + 1 },
      end: { line: mutant.location.end.line + 1, column: mutant.location.end.column + 1 },
    };
    owners[0].expected.push(mutantKey(file, { ...mutant, location }));
  }
  const shards: Shard[] = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    targets: [],
    expected: [],
  }));
  // Preserve the existing disjoint ranges. Cutting an outer block would lose its mutant.
  for (const group of groups.sort(
    (a, b) => b.expected.length - a.expected.length || a.pattern.localeCompare(b.pattern, 'en'),
  )) {
    const shard = [...shards].sort(
      (a, b) => a.expected.length - b.expected.length || a.index - b.index,
    )[0];
    let target = shard.targets.find((item) => item.file === group.file);
    if (!target) {
      target = { ...targets.find((item) => item.file === group.file)!, mutate: [] };
      shard.targets.push(target);
    }
    target.mutate.push(group.pattern);
    shard.expected.push(...group.expected);
  }
  for (const shard of shards) shard.expected.sort();
  // Selection and ignore logic live in these two modules; a change to either must invalidate a
  // cached plan even when the diff and lockfile are unchanged.
  const tooling = [
    readFileSync(fileURLToPath(new URL('./lines.mts', import.meta.url)), 'utf8'),
    readFileSync(fileURLToPath(new URL('./ignore.mts', import.meta.url)), 'utf8'),
  ].join('\n');
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        base,
        head,
        workspace,
        staticMutants,
        targets,
        shards,
        sources: sources.map(({ content }) => content),
        lock: readFileSync('package-lock.json', 'utf8'),
        tooling,
      }),
    )
    .digest('hex');
  return { base, head, workspace, digest, staticMutants, shards };
}
