import { z } from 'zod';
import { skillBrowserFacts, skillServerFacts } from './skills';

const browser = z.discriminatedUnion('name', skillBrowserFacts);
const server = z.discriminatedUnion('name', skillServerFacts);

describe('skill product facts', () => {
  it('keeps catalog opens distinct from object opens', () => {
    const catalog = { name: 'librechat.skills.opened', feature: 'skills', entryPoint: 'route' };
    expect(browser.safeParse(catalog).success).toBe(true);
    expect(browser.safeParse({ ...catalog, skillId: 'skill-1' }).success).toBe(true);
    expect(server.safeParse(catalog).success).toBe(false);
  });

  it('requires persisted identity and rejects content on confirmed writes', () => {
    const added = {
      name: 'librechat.skills.added',
      feature: 'skills',
      skillId: 'skill-1',
      source: 'inline',
    };
    expect(server.safeParse(added).success).toBe(true);
    expect(server.safeParse({ ...added, version: 1 }).success).toBe(false);
    expect(server.safeParse({ ...added, skillId: undefined }).success).toBe(false);
    expect(server.safeParse({ ...added, body: 'private instructions' }).success).toBe(false);
    expect(server.safeParse({ ...added, sourceMetadata: { token: 'secret' } }).success).toBe(false);
  });
});

const syncRunId = '9f4bbf85-b240-4a67-aa48-7f5764969d00';
it.each([
  { name: 'librechat.skills.updated', skillId: 'skill-1' },
  { name: 'librechat.skills.synced', skillId: 'skill-1', syncRunId, change: 'updated' },
  {
    name: 'librechat.skills.sync.finished',
    syncRunId,
    status: 'succeeded',
    unchanged: true,
    changedSkillCount: 0,
    unchangedSkillCount: 1,
    deletedSkillCount: 0,
    skippedSkillCount: 0,
    skippedFileCount: 0,
    durationMs: 10,
  },
])('rejects revision and source identity on $name', (properties) => {
  const fact = { ...properties, feature: 'skills' };
  expect(server.safeParse(fact).success).toBe(true);
  expect(server.safeParse({ ...fact, version: 1 }).success).toBe(false);
  expect(server.safeParse({ ...fact, sourceId: 'a'.repeat(64) }).success).toBe(false);
});
