import { randomUUID } from 'crypto';
import { safelyTrack } from 'librechat-data-provider';
import type { SkillSyncFact } from 'librechat-data-provider';

export type SkillSyncProductTracker = (
  fact: SkillSyncFact,
  context: { actor: 'system'; tenantId?: string },
) => void | Promise<void>;

type Summary = Extract<SkillSyncFact, { name: 'librechat.skills.sync.finished' }>;
type Change = Extract<SkillSyncFact, { name: 'librechat.skills.synced' }>;

/** A source run reports its own changes without borrowing a browser's identity or session. */
export function createSkillSyncTracking(
  track: SkillSyncProductTracker | undefined,
  source: { id: string; tenantId?: string },
) {
  const startedAt = Date.now();
  const reference = {
    syncRunId: randomUUID(),
  };
  const context = { actor: 'system' as const, tenantId: source.tenantId };
  const callback = track ? (fact: SkillSyncFact) => track(fact, context) : undefined;
  let changedSkillCount = 0;
  let deletedSkillCount = 0;
  let unchangedSkillCount = 0;
  return {
    unchanged(): void {
      unchangedSkillCount++;
    },
    changed(skillId: string, change: Change['change']): void {
      if (change === 'removed') deletedSkillCount++;
      else changedSkillCount++;
      safelyTrack(callback, {
        name: 'librechat.skills.synced',
        feature: 'skills',
        ...reference,
        skillId,
        change,
      });
    },
    finish(
      status: Summary['status'],
      counts: { skippedSkillCount: number; skippedFileCount: number },
    ): void {
      safelyTrack(callback, {
        name: 'librechat.skills.sync.finished',
        feature: 'skills',
        ...reference,
        status,
        unchanged: status === 'succeeded' && changedSkillCount === 0 && deletedSkillCount === 0,
        changedSkillCount,
        unchangedSkillCount,
        deletedSkillCount,
        skippedSkillCount: counts.skippedSkillCount,
        skippedFileCount: counts.skippedFileCount,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    },
  };
}
