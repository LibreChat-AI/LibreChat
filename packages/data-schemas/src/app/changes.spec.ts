import type { ConfigOverrideState } from './mutations';
import type { ConfigChange } from './changes';
import {
  applyConfigChange,
  isConfigEntryError,
  applyConfigChanges,
  isSameConfigValue,
  toConfigIdentityPath,
  renameConfigIdentityPath,
  resolveConfigIdentityPath,
  getConfigBatchWrittenPaths,
  getConfigChangeWrittenPaths,
} from './changes';
import { setConfigFields, unsetConfigPaths, tombstoneConfigPaths } from './mutations';
import { isConfigPathError, parseFieldPath } from './paths';

function state(overrides: Record<string, unknown>, tombstones: string[] = []): ConfigOverrideState {
  return { overrides, tombstones };
}

const at = (fieldPath: string): string[] => parseFieldPath(fieldPath);

/** Freezes a value and everything in it, so a transform that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (value != null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}

const CUSTOM = ['endpoints', 'custom'];

const endpoint = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  baseURL: `https://${name}.example.com/v1`,
  models: { default: ['m'] },
  ...extra,
});

describe('applyConfigChanges: parity with the single-kind transforms', () => {
  it('gives the same document as the same changes applied one request at a time', () => {
    const stored = deepFreeze(
      state(
        {
          interface: { modelSelect: true, customWelcome: 'hi' },
          balance: { enabled: true, startBalance: 5 },
          mcpServers: { github: { title: 'GH', url: 'https://gh' } },
        },
        ['memory.agent', 'webSearch'],
      ),
    );
    const changes: ConfigChange[] = [
      { op: 'set', segments: at('interface.modelSelect'), value: false },
      { op: 'unset', segments: at('balance.startBalance') },
      { op: 'tombstone', segments: at('mcpServers.github') },
      { op: 'set', segments: at('webSearch.serperApiKey'), value: '${SERPER}' },
      { op: 'unset', segments: at('memory') },
    ];

    let sequential: ConfigOverrideState = stored;
    sequential = setConfigFields(sequential, [
      { segments: at('interface.modelSelect'), value: false },
    ]);
    sequential = unsetConfigPaths(sequential, [at('balance.startBalance')]);
    sequential = tombstoneConfigPaths(sequential, [at('mcpServers.github')]);
    sequential = setConfigFields(sequential, [
      { segments: at('webSearch.serperApiKey'), value: '${SERPER}' },
    ]);
    sequential = unsetConfigPaths(sequential, [at('memory')]);

    const { state: batched, changed } = applyConfigChanges(stored, changes);

    expect(batched).toEqual(sequential);
    expect(batched).toEqual({
      overrides: {
        interface: { modelSelect: false, customWelcome: 'hi' },
        balance: { enabled: true },
        webSearch: { serperApiKey: '${SERPER}' },
      },
      /** A nested write keeps a whole-section tombstone. */
      tombstones: ['webSearch', 'mcpServers.github'],
    });
    expect(changed).toEqual([true, true, true, true, true]);
  });

  it('applies changes in array order, so the last change to a subtree decides', () => {
    const resetThenSet = applyConfigChanges(state({ a: { x: 1, y: 2 } }), [
      { op: 'unset', segments: at('a') },
      { op: 'set', segments: at('a.y'), value: 3 },
    ]);
    expect(resetThenSet.state.overrides).toEqual({ a: { y: 3 } });

    const setThenReset = applyConfigChanges(state({ a: { x: 1 } }), [
      { op: 'set', segments: at('a.y'), value: 3 },
      { op: 'unset', segments: at('a') },
    ]);
    expect(setThenReset.state.overrides).toEqual({});

    const hideThenShow = applyConfigChanges(state({}), [
      { op: 'tombstone', segments: at('memory.agent') },
      { op: 'set', segments: at('memory.agent.provider'), value: 'openAI' },
    ]);
    expect(hideThenShow.state).toEqual({
      overrides: { memory: { agent: { provider: 'openAI' } } },
      tombstones: [],
    });
  });

  it('never changes its input, and leaves it untouched when a later change fails', () => {
    const stored = deepFreeze(state({ a: { list: [1, 2] } }, ['b.c']));

    const error = errorOf(() =>
      applyConfigChanges(stored, [
        { op: 'set', segments: at('a.z'), value: 1 },
        { op: 'unset', segments: at('a.list.0') },
      ]),
    );

    expect(isConfigPathError(error)).toBe(true);
    expect(stored).toEqual(state({ a: { list: [1, 2] } }, ['b.c']));
  });
});

describe('applyConfigChange: set, unset, tombstone', () => {
  it('clears the written path and its ancestors below the section, never a whole section', () => {
    const next = applyConfigChange(
      state({}, ['memory', 'memory.agent', 'memory.agent.provider', 'memory.agent.model']),
      { op: 'set', segments: at('memory.agent.provider'), value: 'openAI' },
    );

    expect(next.tombstones).toEqual(['memory', 'memory.agent.model']);
  });

  it('removes only the tombstones at or below an unset path', () => {
    const next = applyConfigChange(
      state({ mcpServers: { a: { title: 'A' } } }, [
        'mcpServers.a.headers.X',
        'mcpServers.a',
        'mcpServers.b',
        'mcpServers',
      ]),
      { op: 'unset', segments: at('mcpServers.a') },
    );

    expect(next).toEqual(state({}, ['mcpServers.b', 'mcpServers']));
  });

  it('never leaves a null in an array or shifts its elements', () => {
    const stored = state({ endpoints: { custom: [endpoint('a', { headers: { X: '1' } })] } });

    expect(
      applyConfigChange(stored, { op: 'unset', segments: at('endpoints.custom.0.headers') })
        .overrides,
    ).toEqual({ endpoints: { custom: [endpoint('a')] } });

    const error = errorOf(() =>
      applyConfigChange(stored, { op: 'unset', segments: at('endpoints.custom.0') }),
    );
    expect(isConfigPathError(error) && error.reason).toBe('array_element');
  });

  it('addresses a record key that contains a dot by its segments', () => {
    const path = ['endpoints', 'bedrock', 'inferenceProfiles', 'us.anthropic.claude-sonnet-4-5'];
    const set = applyConfigChange(state({}), { op: 'set', segments: path, value: 'arn:1' });
    expect(set.overrides).toEqual({
      endpoints: { bedrock: { inferenceProfiles: { 'us.anthropic.claude-sonnet-4-5': 'arn:1' } } },
    });

    expect(applyConfigChange(set, { op: 'unset', segments: path }).overrides).toEqual({});

    const error = errorOf(() => applyConfigChange(set, { op: 'tombstone', segments: path }));
    expect(isConfigPathError(error) && error.reason).toBe('dotted_segment');
  });

  it('returns the same state for changes that alter nothing', () => {
    const stored = deepFreeze(state({ a: { b: { c: 1 } } }, ['x.y']));

    expect(applyConfigChange(stored, { op: 'set', segments: at('a.b'), value: { c: 1 } })).toBe(
      stored,
    );
    expect(applyConfigChange(stored, { op: 'unset', segments: at('a.missing') })).toBe(stored);
    expect(applyConfigChange(stored, { op: 'tombstone', segments: at('x.y') })).toBe(stored);
    expect(applyConfigChange(stored, { op: 'set', segments: at('a.b'), value: { c: 2 } })).not.toBe(
      stored,
    );
  });

  it('treats a same-value set over its own tombstone as a change, since it clears it', () => {
    const stored = state({ a: { b: 1 } }, ['a.b']);
    const next = applyConfigChange(stored, { op: 'set', segments: at('a.b'), value: 1 });

    expect(next).not.toBe(stored);
    expect(next.tombstones).toEqual([]);
  });
});

describe('applyConfigChange: upsertEntry and removeEntry', () => {
  it('appends a new entry, creating the array', () => {
    const next = applyConfigChange(state({ endpoints: { agents: { disableBuilder: true } } }), {
      op: 'upsertEntry',
      segments: CUSTOM,
      entry: endpoint('a'),
    });

    expect(next.overrides).toEqual({
      endpoints: { agents: { disableBuilder: true }, custom: [endpoint('a')] },
    });
  });

  it('replaces the entry with the same key in place and drops later duplicates of it', () => {
    const stored = state({
      endpoints: {
        custom: [endpoint('a'), endpoint('b', { apiKey: 'v3:x' }), endpoint('c'), endpoint('b')],
      },
    });

    const next = applyConfigChange(stored, {
      op: 'upsertEntry',
      segments: CUSTOM,
      entry: endpoint('b', { baseURL: 'https://new' }),
    });

    expect(next.overrides).toEqual({
      endpoints: {
        custom: [endpoint('a'), endpoint('b', { baseURL: 'https://new' }), endpoint('c')],
      },
    });
  });

  it('keeps a whole-collection tombstone: adding an own entry does not unhide inherited ones', () => {
    const next = applyConfigChange(state({}, ['endpoints.custom']), {
      op: 'upsertEntry',
      segments: CUSTOM,
      entry: endpoint('a'),
    });

    expect(next.tombstones).toEqual(['endpoints.custom']);
  });

  it('returns the same state for an identical upsert and a missing removal', () => {
    const stored = deepFreeze(state({ endpoints: { custom: [endpoint('a')] } }));

    expect(
      applyConfigChange(stored, { op: 'upsertEntry', segments: CUSTOM, entry: endpoint('a') }),
    ).toBe(stored);
    expect(applyConfigChange(stored, { op: 'removeEntry', segments: CUSTOM, key: 'zzz' })).toBe(
      stored,
    );
  });

  it('removes every own entry with the key, and the array and its emptied parents once empty', () => {
    const stored = state({
      endpoints: { custom: [endpoint('a'), endpoint('b'), endpoint('a')] },
      interface: { modelSelect: true },
    });

    const once = applyConfigChange(stored, { op: 'removeEntry', segments: CUSTOM, key: 'a' });
    expect(once.overrides).toEqual({
      endpoints: { custom: [endpoint('b')] },
      interface: { modelSelect: true },
    });

    const empty = applyConfigChange(once, { op: 'removeEntry', segments: CUSTOM, key: 'b' });
    expect(empty.overrides).toEqual({ interface: { modelSelect: true } });
  });

  it('refuses entry changes outside a merged-by-key array and entries without a key', () => {
    const notKeyed = errorOf(() =>
      applyConfigChange(state({}), {
        op: 'upsertEntry',
        segments: at('modelSpecs.list'),
        entry: { name: 'x' },
      }),
    );
    expect(isConfigEntryError(notKeyed) && notKeyed.reason).toBe('not_collection');

    const keyless = errorOf(() =>
      applyConfigChange(state({}), {
        op: 'upsertEntry',
        segments: CUSTOM,
        entry: { baseURL: 'https://x' },
      }),
    );
    expect(isConfigEntryError(keyless) && keyless.reason).toBe('invalid_entry');

    const malformed = errorOf(() =>
      applyConfigChange(state({ endpoints: { custom: { a: 1 } } }), {
        op: 'removeEntry',
        segments: CUSTOM,
        key: 'a',
      }),
    );
    expect(isConfigEntryError(malformed) && malformed.reason).toBe('not_collection');
  });
});

describe('applyConfigChange: rename', () => {
  it('renames an own merged-by-key entry in place, keeping what is stored on it', () => {
    const stored = deepFreeze(
      state({
        endpoints: {
          custom: [
            endpoint('a'),
            endpoint('old', { apiKey: 'v3:cipher', apiKeyPreview: '...abcd' }),
            endpoint('c'),
          ],
        },
      }),
    );

    const next = applyConfigChange(stored, {
      op: 'rename',
      segments: CUSTOM,
      from: 'old',
      to: 'new',
    });

    expect(next.overrides).toEqual({
      endpoints: {
        custom: [
          endpoint('a'),
          { ...endpoint('old', { apiKey: 'v3:cipher', apiKeyPreview: '...abcd' }), name: 'new' },
          endpoint('c'),
        ],
      },
    });
  });

  it('renames a record key, keeping the key order and clearing a tombstone of the new key', () => {
    const stored = state(
      {
        mcpServers: {
          first: { url: 'https://1' },
          old: { url: 'https://2', headers: { X: '1' } },
          last: { url: 'https://3' },
        },
      },
      ['mcpServers.new', 'mcpServers.other'],
    );

    const next = applyConfigChange(stored, {
      op: 'rename',
      segments: ['mcpServers'],
      from: 'old',
      to: 'new',
    });

    expect(Object.keys((next.overrides as Record<string, object>).mcpServers)).toEqual([
      'first',
      'new',
      'last',
    ]);
    expect(next.overrides).toEqual({
      mcpServers: {
        first: { url: 'https://1' },
        new: { url: 'https://2', headers: { X: '1' } },
        last: { url: 'https://3' },
      },
    });
    expect(next.tombstones).toEqual(['mcpServers.other']);
  });

  it('keeps a `__proto__` record key as data', () => {
    const record = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const next = applyConfigChange(state({ headers: record }), {
      op: 'rename',
      segments: ['headers'],
      from: 'a',
      to: 'b',
    });

    const headers = (next.overrides as { headers: Record<string, unknown> }).headers;
    expect(Object.keys(headers)).toEqual(['b', '__proto__']);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('refuses a missing entry and a taken name, and ignores a rename to the same name', () => {
    const stored = state({ endpoints: { custom: [endpoint('a'), endpoint('b')] } });

    const missing = errorOf(() =>
      applyConfigChange(stored, { op: 'rename', segments: CUSTOM, from: 'zzz', to: 'c' }),
    );
    expect(isConfigEntryError(missing) && missing.reason).toBe('entry_not_found');

    const taken = errorOf(() =>
      applyConfigChange(stored, { op: 'rename', segments: CUSTOM, from: 'a', to: 'b' }),
    );
    expect(isConfigEntryError(taken) && taken.reason).toBe('entry_exists');

    const missingRecord = errorOf(() =>
      applyConfigChange(state({}), {
        op: 'rename',
        segments: ['mcpServers'],
        from: 'a',
        to: 'b',
      }),
    );
    expect(isConfigEntryError(missingRecord) && missingRecord.reason).toBe('entry_not_found');

    expect(applyConfigChange(stored, { op: 'rename', segments: CUSTOM, from: 'a', to: 'a' })).toBe(
      stored,
    );
  });

  it.each([
    ['an unsafe name', '$where'],
    ['a reserved name', '__proto__'],
    ['a name past the length limit', 'k'.repeat(257)],
  ])(
    'refuses %s for an entry of a collection merged by key, as the admin route does',
    (_label, to) => {
      const stored = deepFreeze(
        state({ endpoints: { custom: [endpoint('a')] } }, ['endpoints.custom["a"].headers.X']),
      );

      const refused = errorOf(() =>
        applyConfigChange(stored, { op: 'rename', segments: CUSTOM, from: 'a', to }),
      );

      expect(isConfigEntryError(refused) && refused.reason).toBe('invalid_entry');
    },
  );

  it('lets a renamed entry be edited by its new name later in the same batch', () => {
    const { state: next, changed } = applyConfigChanges(
      state({ endpoints: { custom: [endpoint('old', { apiKey: 'v3:cipher' })] } }),
      [
        { op: 'rename', segments: CUSTOM, from: 'old', to: 'new' },
        { op: 'set', segments: at('interface.modelSelect'), value: true },
        {
          op: 'upsertEntry',
          segments: CUSTOM,
          entry: endpoint('new', { apiKey: 'v3:cipher', baseURL: 'https://changed' }),
        },
      ],
    );

    expect(next.overrides).toEqual({
      endpoints: {
        custom: [endpoint('new', { apiKey: 'v3:cipher', baseURL: 'https://changed' })],
      },
      interface: { modelSelect: true },
    });
    expect(changed).toEqual([true, true, true]);
  });
});

describe('entry changes: keys match as the runtime merge folds them', () => {
  const stored = (custom: unknown[]): ConfigOverrideState =>
    deepFreeze(state({ endpoints: { custom } }));

  it('upserts `ollama` onto a stored `Ollama` in place, under the submitted name', () => {
    const before = stored([
      endpoint('a'),
      endpoint('Ollama', { apiKey: 'v3:cipher' }),
      endpoint('c'),
    ]);
    const entry = endpoint('ollama', { apiKey: 'v3:cipher', modelDisplayLabel: 'Local' });

    const next = applyConfigChange(before, { op: 'upsertEntry', segments: CUSTOM, entry });

    expect(next.overrides).toEqual({
      endpoints: { custom: [endpoint('a'), entry, endpoint('c')] },
    });
    expect(
      getConfigChangeWrittenPaths({ op: 'upsertEntry', segments: CUSTOM, entry }, next),
    ).toEqual([['endpoints', 'custom', '1']]);
  });

  it('replaces every stored spelling of the entry an upsert names, at the first one', () => {
    const before = stored([
      endpoint('Ollama', { apiKey: 'v3:cipher' }),
      endpoint('a'),
      endpoint('OLLAMA', { modelDisplayLabel: 'Old' }),
    ]);
    const entry = endpoint('ollama');

    expect(
      applyConfigChange(before, { op: 'upsertEntry', segments: CUSTOM, entry }).overrides,
    ).toEqual({ endpoints: { custom: [entry, endpoint('a')] } });
  });

  it('removes every stored spelling of the entry a removeEntry names', () => {
    const before = stored([endpoint('Ollama'), endpoint('a'), endpoint('OLLAMA')]);

    expect(
      applyConfigChange(before, { op: 'removeEntry', segments: CUSTOM, key: 'ollama' }).overrides,
    ).toEqual({ endpoints: { custom: [endpoint('a')] } });
    expect(
      applyConfigChange(stored([endpoint('Ollama')]), {
        op: 'removeEntry',
        segments: CUSTOM,
        key: 'ollama',
      }).overrides,
    ).toEqual({});
  });

  it('refuses a rename onto another spelling of a stored entry, and renames by any spelling', () => {
    const ollama = endpoint('Ollama', { apiKey: 'v3:cipher' });
    const before = stored([ollama, endpoint('foo')]);

    const taken = errorOf(() =>
      applyConfigChange(before, { op: 'rename', segments: CUSTOM, from: 'foo', to: 'ollama' }),
    );
    expect(isConfigEntryError(taken) && taken.reason).toBe('entry_exists');

    expect(
      applyConfigChange(before, { op: 'rename', segments: CUSTOM, from: 'ollama', to: 'local' })
        .overrides,
    ).toEqual({ endpoints: { custom: [{ ...ollama, name: 'local' }, endpoint('foo')] } });
    expect(
      applyConfigChange(before, { op: 'rename', segments: CUSTOM, from: 'Ollama', to: 'ollama' })
        .overrides,
    ).toEqual({ endpoints: { custom: [{ ...ollama, name: 'ollama' }, endpoint('foo')] } });
  });

  it('renames an entry stored in two spellings as the one entry the runtime merge combines', () => {
    const before = stored([
      endpoint('Ollama', { baseURL: 'https://first.example.com', apiKey: 'v3:cipher' }),
      endpoint('foo'),
      { name: 'ollama', modelDisplayLabel: 'Later' },
    ]);

    const next = applyConfigChange(before, {
      op: 'rename',
      segments: CUSTOM,
      from: 'ollama',
      to: 'local',
    });

    expect(next.overrides).toEqual({
      endpoints: {
        custom: [
          endpoint('local', {
            baseURL: 'https://first.example.com',
            apiKey: 'v3:cipher',
            modelDisplayLabel: 'Later',
          }),
          endpoint('foo'),
        ],
      },
    });
  });

  it('keeps every other entry name exact', () => {
    const before = stored([endpoint('Foo')]);

    expect(
      applyConfigChange(before, { op: 'upsertEntry', segments: CUSTOM, entry: endpoint('foo') })
        .overrides,
    ).toEqual({ endpoints: { custom: [endpoint('Foo'), endpoint('foo')] } });
    expect(applyConfigChange(before, { op: 'removeEntry', segments: CUSTOM, key: 'foo' })).toBe(
      before,
    );
    const missing = errorOf(() =>
      applyConfigChange(before, { op: 'rename', segments: CUSTOM, from: 'foo', to: 'bar' }),
    );
    expect(isConfigEntryError(missing) && missing.reason).toBe('entry_not_found');
  });
});

describe('getConfigChangeWrittenPaths', () => {
  it('names a field change by its path and an entry change by the entry it wrote, a removal by nothing', () => {
    const result = state({ endpoints: { custom: [endpoint('a'), endpoint('b')] } });

    expect(
      getConfigChangeWrittenPaths({ op: 'set', segments: at('a.b'), value: 1 }, result),
    ).toEqual([['a', 'b']]);
    expect(
      getConfigChangeWrittenPaths(
        { op: 'upsertEntry', segments: CUSTOM, entry: endpoint('b') },
        result,
      ),
    ).toEqual([['endpoints', 'custom', '1']]);
    expect(
      getConfigChangeWrittenPaths({ op: 'rename', segments: CUSTOM, from: 'x', to: 'b' }, result),
    ).toEqual([['endpoints', 'custom', '1']]);
    expect(
      getConfigChangeWrittenPaths({ op: 'removeEntry', segments: CUSTOM, key: 'a' }, result),
    ).toEqual([]);
    expect(
      getConfigChangeWrittenPaths(
        { op: 'rename', segments: ['mcpServers'], from: 'x', to: 'y' },
        result,
      ),
    ).toEqual([
      ['mcpServers', 'x'],
      ['mcpServers', 'y'],
    ]);
  });
});

describe('getConfigBatchWrittenPaths', () => {
  const written = (stored: ConfigOverrideState, changes: ConfigChange[]): string[][] =>
    getConfigBatchWrittenPaths(changes, applyConfigChanges(stored, changes).state, stored);

  it('leaves out what a later change of the batch puts back as stored', () => {
    const balance = { enabled: true, startBalance: 'legacy' };
    const stored = state({ balance });

    expect(
      written(stored, [
        { op: 'set', segments: at('balance.startBalance'), value: 1000 },
        { op: 'set', segments: at('balance'), value: balance },
        { op: 'set', segments: at('interface.customWelcome'), value: 'hi' },
      ]),
    ).toEqual([['interface', 'customWelcome']]);
    expect(
      written(stored, [
        { op: 'set', segments: at('balance.startBalance'), value: 1000 },
        { op: 'set', segments: at('balance'), value: { ...balance, enabled: false } },
      ]),
    ).toEqual([['balance']]);
  });

  it('keeps a path whose inherited value a tombstone change hides or shows again', () => {
    const stored = state({ memory: { agent: { id: 'a' } } }, ['interface']);

    expect(
      written(stored, [
        { op: 'unset', segments: at('memory.agent.id') },
        { op: 'set', segments: at('memory.agent.id'), value: 'a' },
      ]),
    ).toEqual([]);
    expect(
      written(stored, [
        { op: 'set', segments: at('memory.agent.id'), value: 'a' },
        { op: 'tombstone', segments: at('memory.agent') },
      ]),
    ).toEqual([
      ['memory', 'agent', 'id'],
      ['memory', 'agent'],
    ]);
    expect(written(stored, [{ op: 'unset', segments: at('interface') }])).toEqual([['interface']]);
  });

  it('names an entry where the batch leaves it and compares it with the stored entry of its key', () => {
    const stored = state({ endpoints: { custom: [endpoint('a'), endpoint('b'), endpoint('c')] } });

    expect(
      written(stored, [
        { op: 'upsertEntry', segments: CUSTOM, entry: { ...endpoint('b'), models: ['n'] } },
        { op: 'removeEntry', segments: CUSTOM, key: 'a' },
      ]),
    ).toEqual([['endpoints', 'custom', '0']]);
    expect(
      written(stored, [
        { op: 'rename', segments: CUSTOM, from: 'c', to: 'z' },
        { op: 'rename', segments: CUSTOM, from: 'z', to: 'c' },
        { op: 'removeEntry', segments: CUSTOM, key: 'a' },
      ]),
    ).toEqual([]);
  });
});

describe('config identity paths', () => {
  const doc = {
    endpoints: { custom: [{ name: 'Good' }, { name: 'Ollama', headers: { K: 'v' } }, { x: 1 }] },
    mcpServers: { draft: { url: 'u' } },
  };

  it('names an entry of a merged-by-key array by its key, anything else by segment', () => {
    expect(toConfigIdentityPath(doc, ['endpoints', 'custom', '1', 'headers', 'K'])).toEqual([
      'endpoints',
      'custom',
      { entry: 'Ollama' },
      'headers',
      'K',
    ]);
    expect(toConfigIdentityPath(doc, ['endpoints', 'custom', '2', 'x'])).toEqual(
      at('endpoints.custom.2.x'),
    );
  });

  it('finds an entry where another document holds it, under a folded spelling too', () => {
    const path = toConfigIdentityPath(doc, ['endpoints', 'custom', '1', 'headers', 'K']);

    expect(
      resolveConfigIdentityPath({ endpoints: { custom: [{ name: 'ollama' }] } }, path),
    ).toEqual(at('endpoints.custom.0.headers.K'));
    expect(resolveConfigIdentityPath({ endpoints: { custom: [{ name: 'Good' }] } }, path)).toBe(
      null,
    );
  });

  it('follows a rename of the record key or entry the path passes through, and nothing else', () => {
    const server = toConfigIdentityPath(doc, at('mcpServers.draft.url'));
    const entry = toConfigIdentityPath(doc, at('endpoints.custom.1.headers.K'));

    expect(renameConfigIdentityPath(server, ['mcpServers'], 'draft', 'tools')).toEqual(
      at('mcpServers.tools.url'),
    );
    expect(renameConfigIdentityPath(server, ['mcpServers'], 'other', 'tools')).toEqual(server);
    expect(renameConfigIdentityPath(entry, CUSTOM, 'OLLAMA', 'Renamed')).toEqual([
      ...CUSTOM,
      { entry: 'Renamed' },
      'headers',
      'K',
    ]);
    expect(renameConfigIdentityPath(entry, CUSTOM, 'Good', 'x')).toEqual(entry);
    expect(renameConfigIdentityPath(entry, ['mcpServers'], 'Ollama', 'x')).toEqual(entry);
  });
});

describe('isSameConfigValue', () => {
  it('compares JSON structurally, ignoring object key order but not array order', () => {
    expect(isSameConfigValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(isSameConfigValue([1, 2], [2, 1])).toBe(false);
    expect(isSameConfigValue({ a: undefined }, {})).toBe(false);
    expect(isSameConfigValue({ a: 1 }, { a: '1' })).toBe(false);
    expect(isSameConfigValue(null, {})).toBe(false);
  });
});

describe('keyed changes: entries of an array merged by key, by key', () => {
  const keyedChange = (op: 'unset' | 'tombstone', key: string, rest: string[] = []) =>
    ({ op, segments: CUSTOM, entry: { key, rest } }) as ConfigChange;

  it('hides an entry, then shows it again when the same batch upserts it', () => {
    const stored = deepFreeze(state({ endpoints: { custom: [endpoint('gw')] } }));
    const { state: hidden } = applyConfigChanges(stored, [keyedChange('tombstone', 'gw')]);
    expect(hidden).toEqual(state({}, ['endpoints.custom["gw"]']));

    const { state: shown, changed } = applyConfigChanges(hidden, [
      { op: 'upsertEntry', segments: CUSTOM, entry: endpoint('gw') },
    ]);
    expect(changed).toEqual([true]);
    expect(shown).toEqual(state({ endpoints: { custom: [endpoint('gw')] } }));
  });

  it('an upsert of an entry clears its hide even when the stored entry is already the same', () => {
    const hiddenWithEntry = state({ endpoints: { custom: [endpoint('gw')] } }, [
      'endpoints.custom["gw"]',
      'endpoints.custom["gw"].headers.A',
    ]);
    const next = applyConfigChange(hiddenWithEntry, {
      op: 'upsertEntry',
      segments: CUSTOM,
      entry: endpoint('gw'),
    });
    expect(next.tombstones).toEqual(['endpoints.custom["gw"].headers.A']);
    const set = applyConfigChange(hiddenWithEntry, {
      op: 'set',
      segments: CUSTOM,
      value: [endpoint('gw')],
    });
    expect(set).not.toBe(hiddenWithEntry);
    expect(set.tombstones).toEqual(['endpoints.custom["gw"].headers.A']);
  });

  it('keeps a tombstone inside an entry through an edit of the entry in the same batch', () => {
    const stored = state({ endpoints: { custom: [endpoint('gw', { headers: { A: 'a' } })] } });
    const { state: next } = applyConfigChanges(stored, [
      { op: 'upsertEntry', segments: CUSTOM, entry: endpoint('gw', { titleModel: 't' }) },
      keyedChange('tombstone', 'gw', ['headers', 'B']),
    ]);
    expect(next).toEqual(
      state({ endpoints: { custom: [endpoint('gw', { titleModel: 't' })] } }, [
        'endpoints.custom["gw"].headers.B',
      ]),
    );
  });

  it('resets an entry by key with its keyed tombstones, and reports no change when there is none', () => {
    const stored = state({ endpoints: { custom: [endpoint('Ollama')] } }, [
      'endpoints.custom["Ollama"].headers.A',
    ]);
    expect(applyConfigChange(stored, keyedChange('unset', 'ollama'))).toEqual(state({}));
    const untouched = state({ endpoints: { custom: [endpoint('gw')] } });
    expect(applyConfigChange(untouched, keyedChange('unset', 'gw', ['headers', 'A']))).toBe(
      untouched,
    );
    expect(applyConfigChange(untouched, keyedChange('unset', 'other'))).toBe(untouched);
  });

  it('moves the keyed tombstones of an entry a batch renames', () => {
    const stored = state({ endpoints: { custom: [endpoint('draft')] } }, [
      'endpoints.custom["draft"].headers.A',
    ]);
    const next = applyConfigChange(stored, {
      op: 'rename',
      segments: CUSTOM,
      from: 'draft',
      to: 'final',
    });
    expect(next).toEqual(
      state({ endpoints: { custom: [endpoint('draft', { name: 'final' })] } }, [
        'endpoints.custom["final"].headers.A',
      ]),
    );
  });

  it('counts a set that only shows an entry it writes again as a write of the collection', () => {
    const stored = state({ endpoints: { custom: [endpoint('gw')] } }, ['endpoints.custom["gw"]']);
    const batch: ConfigChange[] = [{ op: 'set', segments: CUSTOM, value: [endpoint('gw')] }];
    const { state: result } = applyConfigChanges(stored, batch);
    expect(result.tombstones).toEqual([]);
    expect(getConfigBatchWrittenPaths(batch, result, stored)).toEqual([CUSTOM]);
  });

  it('a set or record rename by segments that only spell an entry keeps its keyed tombstones', () => {
    const stored = state({ endpoints: { junk: { a: 1 } } }, [
      'endpoints.custom["GPT"]',
      'endpoints.custom["OR"].headers.X',
    ]);
    const set = applyConfigChange(stored, {
      op: 'set',
      segments: ['endpoints', 'custom["OR"]', 'headers', 'X'],
      value: 'v',
    });
    expect(set.tombstones).toEqual(stored.tombstones);
    const renamed = applyConfigChange(stored, {
      op: 'rename',
      segments: ['endpoints'],
      from: 'junk',
      to: 'custom["GPT"]',
    });
    expect(renamed).toEqual(state({ endpoints: { 'custom["GPT"]': { a: 1 } } }, stored.tombstones));
  });

  it('refuses a keyed change whose path inside the entry its stored tombstone could not name', () => {
    const stored = state({ endpoints: { custom: [endpoint('K', { headers: { 'a.b': 'x' } })] } });
    for (const op of ['tombstone', 'unset'] as const) {
      const error = errorOf(() =>
        applyConfigChange(stored, keyedChange(op, 'K', ['headers', 'a.b'])),
      );
      expect(isConfigPathError(error) && error.reason).toBe('dotted_segment');
    }
  });

  it('names a keyed change by the own entry it leaves, or by nothing once it removed it', () => {
    const stored = state({
      endpoints: { custom: [endpoint('a'), endpoint('gw', { headers: { A: 'a', B: 'b' } })] },
    });
    const inside = keyedChange('tombstone', 'gw', ['headers', 'A']);
    expect(getConfigChangeWrittenPaths(inside, applyConfigChange(stored, inside))).toEqual([
      ['endpoints', 'custom', '1'],
    ]);
    const whole = keyedChange('tombstone', 'gw');
    expect(getConfigChangeWrittenPaths(whole, applyConfigChange(stored, whole))).toEqual([]);
  });
});
