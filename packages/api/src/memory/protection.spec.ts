import type { FiltersConfig, MemoryFilterField } from 'librechat-data-provider';
import { ContentTraversalLimitError } from '~/protection';
import { projectStoredMemories } from './protection';

const memoryFilters = (fields?: MemoryFilterField[]): FiltersConfig => ({
  memories: {
    pii: {
      fields,
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    },
  },
});

describe('projectStoredMemories', () => {
  it('redacts a record stored before the current policy was enabled', () => {
    const stored = {
      _id: 'memory-1',
      key: 'safe key',
      value: 'PRIVATE-STORED',
      summary: 'safe summary',
      tokenCount: 4,
    };

    const [projected] = projectStoredMemories([stored], memoryFilters());

    expect(projected).toEqual({
      _id: 'memory-1',
      key: 'safe key',
      value: '',
      summary: 'safe summary',
      tokenCount: 4,
      contentFilterBlocked: true,
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE-STORED');
  });

  it('returns safe records unchanged', () => {
    const safe = { _id: 'memory-safe', key: 'timezone', value: 'UTC' };

    const [projected] = projectStoredMemories([safe], memoryFilters());

    expect(projected).toBe(safe);
    expect(projected).not.toHaveProperty('contentFilterBlocked');
  });

  it('honors selected fields and redacts only policy-covered memory fields', () => {
    const records = [
      { _id: 'key-only', key: 'PRIVATE-KEY', value: 'safe value', summary: 'safe summary' },
      { _id: 'value', key: 'editable key', value: 'PRIVATE-VALUE', summary: 'visible summary' },
    ];

    const projected = projectStoredMemories(records, memoryFilters(['value']));

    expect(projected[0]).toBe(records[0]);
    expect(projected[1]).toEqual({
      _id: 'value',
      key: 'editable key',
      value: '',
      summary: 'visible summary',
      contentFilterBlocked: true,
    });
  });

  it('keeps a safe key usable when the value alone is blocked under default fields', () => {
    const [projected] = projectStoredMemories(
      [{ _id: 'editable', key: 'editable key', value: 'PRIVATE-VALUE' }],
      memoryFilters(),
    );

    expect(projected).toEqual({
      _id: 'editable',
      key: 'editable key',
      value: '',
      contentFilterBlocked: true,
    });
  });

  it('supports summary-only policy without removing safe management keys', () => {
    const [projected] = projectStoredMemories(
      [{ _id: 'summary', key: 'editable key', value: 'safe value', summary: 'PRIVATE-SUMMARY' }],
      memoryFilters(['summary']),
    );

    expect(projected).toEqual({
      _id: 'summary',
      key: 'editable key',
      value: 'safe value',
      summary: '',
      contentFilterBlocked: true,
    });
  });

  it('redacts a blocked key while retaining the record identifier and safe value', () => {
    const [projected] = projectStoredMemories(
      [{ _id: 'blocked-key', key: 'PRIVATE-KEY', value: 'safe value' }],
      memoryFilters(['key']),
    );

    expect(projected).toEqual({
      _id: 'blocked-key',
      key: '',
      value: 'safe value',
      contentFilterBlocked: true,
    });
  });

  it('fails closed with a raw-free projection when selected memory traversal is incomplete', () => {
    const secret = 'PRIVATE-TRAVERSAL';
    const [projected] = projectStoredMemories(
      [{ _id: 'traversal', key: 'editable key', value: secret }],
      memoryFilters(['value']),
      {
        extract: () => {
          throw new ContentTraversalLimitError([], [{ source: 'memory', fields: ['value'] }]);
        },
      },
    );

    expect(projected).toEqual({
      _id: 'traversal',
      key: 'editable key',
      value: '',
      contentFilterBlocked: true,
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
  });

  it('does not fail closed for traversal outside selected memory fields', () => {
    const stored = { _id: 'traversal', key: 'safe key', value: 'PRIVATE-VALUE' };
    const [projected] = projectStoredMemories([stored], memoryFilters(['key']), {
      extract: () => {
        throw new ContentTraversalLimitError([], [{ source: 'memory', fields: ['value'] }]);
      },
    });

    expect(projected).toBe(stored);
  });
});
