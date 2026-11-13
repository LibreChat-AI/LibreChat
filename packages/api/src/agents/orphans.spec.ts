import { EToolResources } from 'librechat-data-provider';
import type { AgentToolResources } from 'librechat-data-provider';
import {
  collectToolResourceFileIds,
  normalizeToolResourceFiles,
  resolveDuplicateToolResources,
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

describe('resolveDuplicateToolResources', () => {
  it('carries every agent-scoped partition the source holds', () => {
    const resources: AgentToolResources = {
      [EToolResources.context]: { file_ids: ['ctx'] },
      [EToolResources.execute_code]: { file_ids: ['code'] },
      [EToolResources.file_search]: { file_ids: ['search'] },
      [EToolResources.image_edit]: { file_ids: ['image'] },
    };

    expect(resolveDuplicateToolResources(resources)).toEqual(resources);
  });

  it('folds legacy ocr uploads into context', () => {
    const resources = {
      [EToolResources.ocr]: { file_ids: ['scanned'] },
    } as AgentToolResources;

    expect(resolveDuplicateToolResources(resources)).toEqual({
      [EToolResources.context]: { file_ids: ['scanned'] },
    });
  });

  it('keeps context file_ids when the source holds both context and ocr', () => {
    const resources = {
      [EToolResources.context]: { file_ids: ['ctx'] },
      [EToolResources.ocr]: { file_ids: ['scanned'] },
    } as AgentToolResources;

    const duplicate = resolveDuplicateToolResources(resources);

    expect(duplicate?.[EToolResources.context]?.file_ids).toEqual(['ctx', 'scanned']);
    expect(duplicate?.[EToolResources.ocr]).toBeUndefined();
  });

  it('returns undefined when the source holds no resources', () => {
    expect(resolveDuplicateToolResources(undefined)).toBeUndefined();
    expect(resolveDuplicateToolResources(null)).toBeUndefined();
    expect(resolveDuplicateToolResources({})).toBeUndefined();
  });

  it('copies each partition so later pruning cannot reach the source', () => {
    const resources: AgentToolResources = {
      [EToolResources.execute_code]: { file_ids: ['code'] },
    };

    const duplicate = resolveDuplicateToolResources(resources);
    expect(duplicate?.[EToolResources.execute_code]).not.toBe(
      resources[EToolResources.execute_code],
    );

    stripFileIdsFromToolResources(duplicate, ['code']);
    expect(resources[EToolResources.execute_code]?.file_ids).toEqual(['code']);
  });
});
