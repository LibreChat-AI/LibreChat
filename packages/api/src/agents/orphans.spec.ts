import { EToolResources } from 'librechat-data-provider';
import type { AgentToolResources } from 'librechat-data-provider';
import {
  collectToolResourceFileIds,
  normalizeToolResourceFiles,
  stripFileIdsFromToolResources,
} from './orphans';

const makeResources = (): AgentToolResources => ({
  [EToolResources.file_search]: { file_ids: ['a', 'b', 'c'] },
  [EToolResources.execute_code]: { file_ids: ['b', 'd'] },
  [EToolResources.context]: { file_ids: ['e'] },
});

describe('collectToolResourceFileIds', () => {
  it('returns empty array for nullish input', () => {
    expect(collectToolResourceFileIds(undefined)).toEqual([]);
    expect(collectToolResourceFileIds(null)).toEqual([]);
  });

  it('gathers and de-duplicates file_ids across every category', () => {
    const ids = collectToolResourceFileIds(makeResources());
    expect(new Set(ids)).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('skips categories without a file_ids array', () => {
    const resources: AgentToolResources = {
      [EToolResources.file_search]: { file_ids: ['a'] },
      [EToolResources.context]: {},
    };
    expect(collectToolResourceFileIds(resources)).toEqual(['a']);
  });
});

describe('stripFileIdsFromToolResources', () => {
  it('removes matching ids from every category and reports the count', () => {
    const resources = makeResources();
    const { removedCount } = stripFileIdsFromToolResources(resources, ['b', 'e']);

    expect(removedCount).toBe(3);
    expect(resources[EToolResources.file_search]?.file_ids).toEqual(['a', 'c']);
    expect(resources[EToolResources.execute_code]?.file_ids).toEqual(['d']);
    expect(resources[EToolResources.context]?.file_ids).toEqual([]);
  });

  it('is a no-op when no ids are provided', () => {
    const resources = makeResources();
    const { removedCount } = stripFileIdsFromToolResources(resources, []);
    expect(removedCount).toBe(0);
    expect(resources[EToolResources.file_search]?.file_ids).toEqual(['a', 'b', 'c']);
  });

  it('handles nullish tool_resources safely', () => {
    const { removedCount } = stripFileIdsFromToolResources(undefined, ['a']);
    expect(removedCount).toBe(0);
  });
});

describe('normalizeToolResourceFiles', () => {
  it('retains only identifiers from client-hydrated file objects', () => {
    const resources = {
      [EToolResources.execute_code]: {
        file_ids: ['existing'],
        files: [
          {
            file_id: 'hydrated',
            filename: 'PRIVATE-SENTINEL',
            metadata: { codeEnvRef: { file_id: 'untrusted' } },
          },
        ],
      },
    } as AgentToolResources;

    normalizeToolResourceFiles(resources);

    expect(resources[EToolResources.execute_code]).toEqual({
      file_ids: ['existing', 'hydrated'],
    });
    expect(JSON.stringify(resources)).not.toContain('PRIVATE-SENTINEL');
    expect(JSON.stringify(resources)).not.toContain('untrusted');
  });
});
