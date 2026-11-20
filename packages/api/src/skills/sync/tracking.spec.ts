import { createSkillSyncTracking } from './tracking';

describe('system skill sync tracking', () => {
  it('reports an unchanged run without emitting per-skill events or user/session identity', () => {
    const track = jest.fn();
    const tracking = createSkillSyncTracking(track, { id: 'private source', tenantId: 'tenant-1' });
    tracking.unchanged();
    tracking.unchanged();
    tracking.finish('succeeded', { skippedSkillCount: 0, skippedFileCount: 0 });

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'librechat.skills.sync.finished',
        status: 'succeeded',
        unchanged: true,
        unchangedSkillCount: 2,
        changedSkillCount: 0,
        syncRunId: expect.any(String),
      }),
      { actor: 'system', tenantId: 'tenant-1' },
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain('private source');
    expect(track.mock.calls[0][0]).not.toHaveProperty('sourceId');
  });

  it('keeps changes from a partial run connected to its summary', () => {
    const track = jest.fn();
    const tracking = createSkillSyncTracking(track, { id: 'source' });
    tracking.changed('skill-1', 'updated');
    tracking.changed('skill-2', 'removed');
    tracking.finish('partial', { skippedSkillCount: 1, skippedFileCount: 2 });

    const [updated, removed, summary] = track.mock.calls.map(([fact]) => fact);
    for (const fact of [updated, removed, summary]) {
      expect(fact).not.toHaveProperty('version');
      expect(fact).not.toHaveProperty('sourceId');
    }
    expect(updated.syncRunId).toBe(summary.syncRunId);
    expect(removed.syncRunId).toBe(summary.syncRunId);
    expect(summary).toMatchObject({
      status: 'partial',
      unchanged: false,
      changedSkillCount: 1,
      deletedSkillCount: 1,
      skippedSkillCount: 1,
      skippedFileCount: 2,
    });
  });

  it('isolates rejected host delivery from sync', async () => {
    const tracking = createSkillSyncTracking(() => Promise.reject(new Error('offline')), {
      id: 'source',
    });
    expect(() => tracking.changed('skill-1', 'added')).not.toThrow();
    expect(() =>
      tracking.finish('failed', { skippedSkillCount: 1, skippedFileCount: 0 }),
    ).not.toThrow();
    await Promise.resolve();
  });
});
