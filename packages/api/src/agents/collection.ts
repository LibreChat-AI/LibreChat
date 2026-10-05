import type { UsageMetadata } from '~/stream/interfaces/IJobStore';

/** One model call can report consumption through completion and native failure recovery. */
export function collectModelUsage(
  collected: UsageMetadata[],
  input: UsageMetadata,
  nativeModelRunId?: unknown,
): boolean {
  const usage =
    typeof nativeModelRunId === 'string' ? { ...input, modelRunId: nativeModelRunId } : input;
  const existing = usage.modelRunId
    ? collected.find((entry) => entry.modelRunId === usage.modelRunId)
    : undefined;
  if (existing) {
    Object.assign(existing, usage);
    return false;
  }
  collected.push(usage);
  return true;
}
