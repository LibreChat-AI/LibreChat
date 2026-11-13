import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';

import type { Mutant, MutationRange } from '@stryker-mutator/api/core';
import type { mutationSelection } from './risk.mts';

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
  const { mutants } = await instrumenter.instrument(sources, {
    plugins: null,
    ignorers: [],
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
      }),
    )
    .digest('hex');
  return { base, head, workspace, digest, staticMutants, shards };
}
