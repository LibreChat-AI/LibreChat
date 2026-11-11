export interface Shard {
  index: number;
  total: number;
}

export function parseShard(
  value: string | undefined,
  check: string | undefined,
): Shard | undefined {
  if (value === undefined) return undefined;
  if (check !== 'mutation') throw new Error('--shard is only allowed for mutation checks');
  if (!/^[1-9]\d*\/[1-9]\d*$/u.test(value)) {
    throw new Error('--shard must be INDEX/COUNT with positive integers and INDEX <= COUNT');
  }
  const [index, total] = value.split('/').map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    throw new Error('--shard must be INDEX/COUNT with positive integers and INDEX <= COUNT');
  }
  return { index, total };
}

export function shardTargets<T extends { file: string; functions: readonly unknown[] }>(
  targets: readonly T[],
  shard?: Shard,
): readonly T[] {
  if (!shard) return targets;
  return [...targets]
    .sort((a, b) => b.functions.length - a.functions.length || a.file.localeCompare(b.file))
    .filter((_target, index) => index % shard.total === shard.index - 1);
}
