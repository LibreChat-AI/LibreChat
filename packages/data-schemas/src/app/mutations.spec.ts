import type { ConfigOverrideState } from './mutations';
import {
  setConfigFields,
  unsetConfigPaths,
  toConfigOverrideState,
  tombstoneConfigPaths,
  replaceConfigOverrides,
  getWriteClearedTombstones,
  isConfigOverrideStateEmpty,
  renameConfigEntryTombstones,
  renameConfigEntriesTombstones,
} from './mutations';
import { isConfigPathError, parseFieldPath } from './paths';

function state(overrides: Record<string, unknown>, tombstones: string[] = []): ConfigOverrideState {
  return { overrides, tombstones };
}

const at = (fieldPath: string): string[] => parseFieldPath(fieldPath);

describe('setConfigFields', () => {
  it('applies writes in order and clears the tombstones they write over', () => {
    const input = state({ a: { x: 1 } }, ['memory', 'memory.agent', 'mcpServers.github', 'a.b']);

    const next = setConfigFields(input, [
      { segments: at('a.b'), value: { c: 1 } },
      { segments: at('a.b.c'), value: 2 },
      { segments: at('memory.agent.provider'), value: 'openAI' },
    ]);

    expect(next.overrides).toEqual({
      a: { x: 1, b: { c: 2 } },
      memory: { agent: { provider: 'openAI' } },
    });
    expect(next.tombstones).toEqual(['memory', 'mcpServers.github']);
    expect(input.overrides).toEqual({ a: { x: 1 } });
  });

  it('writes a record whose keys contain dots at its own path', () => {
    const next = setConfigFields(state({}), [
      {
        segments: ['endpoints', 'azureOpenAI', 'groups'],
        value: [{ models: { 'gpt-4.1': true } }],
      },
    ]);

    expect(next.overrides).toEqual({
      endpoints: { azureOpenAI: { groups: [{ models: { 'gpt-4.1': true } }] } },
    });
  });

  it('refuses a write below a stored scalar', () => {
    let caught: unknown;
    try {
      setConfigFields(state({ interface: { modelSelect: true } }), [
        { segments: at('interface.modelSelect.nested'), value: 1 },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(isConfigPathError(caught)).toBe(true);
  });
});

describe('unsetConfigPaths', () => {
  it('prunes parents a reset leaves empty and keeps siblings', () => {
    expect(
      unsetConfigPaths(state({ balance: { startBalance: 5 } }), [at('balance.startBalance')])
        .overrides,
    ).toEqual({});
    expect(
      unsetConfigPaths(state({ balance: { a: 1, b: 2 } }), [at('balance.a')]).overrides,
    ).toEqual({
      balance: { b: 2 },
    });
    expect(
      unsetConfigPaths(
        state({ endpoints: { anthropic: { models: { x: 1 } }, openAI: { a: 1 } } }),
        [at('endpoints.anthropic.models.x')],
      ).overrides,
    ).toEqual({ endpoints: { openAI: { a: 1 } } });
  });

  it('prunes inside an array element without removing or nulling the element', () => {
    const next = unsetConfigPaths(
      state({ endpoints: { custom: [{ name: 'a', headers: { A: '1' } }] } }),
      [at('endpoints.custom.0.headers.A')],
    );

    expect(next.overrides).toEqual({ endpoints: { custom: [{ name: 'a' }] } });
  });

  it('drops tombstones at or below the path and keeps the rest, even under a pruned parent', () => {
    const next = unsetConfigPaths(
      state({ mcpServers: { foo: { title: 'Foo' } } }, [
        'mcpServers.github',
        'mcpServers.foo.url',
        'mcpServers.foo',
      ]),
      [at('mcpServers.foo')],
    );

    expect(next.overrides).toEqual({});
    expect(next.tombstones).toEqual(['mcpServers.github']);
  });

  it('drops a stored tombstone of a record key holding `["` by that key, as it was written', () => {
    const legacy = state({}, ['mcpServers.a["b"]']);

    expect(unsetConfigPaths(legacy, [['mcpServers', 'a']]).tombstones).toEqual([
      'mcpServers.a["b"]',
    ]);
    expect(unsetConfigPaths(legacy, [['mcpServers', 'a["b"]']]).tombstones).toEqual([]);
  });

  it('removes a secret and its preview companion together and prunes once', () => {
    const next = unsetConfigPaths(state({ ocr: { apiKey: 'v3:x', apiKeyPreview: '...abcd' } }), [
      at('ocr.apiKey'),
      at('ocr.apiKeyPreview'),
    ]);

    expect(next.overrides).toEqual({});
  });

  it('prunes an emptied atomic theme, so the base theme is inherited again', () => {
    const next = unsetConfigPaths(state({ interface: { theme: { primary: '#000' } } }), [
      at('interface.theme.primary'),
    ]);

    expect(next.overrides).toEqual({});
  });
});

describe('tombstoneConfigPaths', () => {
  it('removes the subtree, prunes, and records each tombstone once', () => {
    const next = tombstoneConfigPaths(
      state({ mcpServers: { github: { title: 'GH' } }, memory: { agent: { id: 'x' } } }, [
        'memory.agent',
      ]),
      [at('mcpServers.github'), at('memory.agent')],
    );

    expect(next.overrides).toEqual({});
    expect(next.tombstones).toEqual(['memory.agent', 'mcpServers.github']);
  });

  it('refuses a path a tombstone cannot name', () => {
    let caught: unknown;
    try {
      tombstoneConfigPaths(state({}), [['endpoints', 'gpt-4.1']]);
    } catch (error) {
      caught = error;
    }

    expect(isConfigPathError(caught)).toBe(true);
  });
});

describe('replaceConfigOverrides and emptiness', () => {
  it('replaces overrides and keeps tombstones', () => {
    expect(replaceConfigOverrides(state({ a: 1 }, ['x.y']), { b: 2 } as never)).toEqual(
      state({ b: 2 }, ['x.y']),
    );
  });

  it('counts shells-only documents without tombstones as empty', () => {
    expect(isConfigOverrideStateEmpty(state({}))).toBe(true);
    expect(isConfigOverrideStateEmpty(state({ balance: {}, endpoints: { custom: {} } }))).toBe(
      true,
    );
    expect(isConfigOverrideStateEmpty(state({}, ['memory']))).toBe(false);
    expect(isConfigOverrideStateEmpty(state({ balance: { enabled: false } }))).toBe(false);
  });

  it('reads a missing or malformed document as the empty state', () => {
    expect(toConfigOverrideState(null)).toEqual(state({}));
    expect(toConfigOverrideState({ overrides: [], tombstones: ['a', 3] })).toEqual(
      state({}, ['a']),
    );
  });
});

describe('keyed locations: entries of an array merged by key', () => {
  const CUSTOM = ['endpoints', 'custom'];
  const keyed = (key: string, rest: string[] = []) => ({ segments: CUSTOM, entry: { key, rest } });
  const own = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    baseURL: `https://${name}.example.com`,
    ...extra,
  });

  it('hides an inherited entry on a document with no array, storing the canonical keyed path', () => {
    const next = tombstoneConfigPaths(state({}), [keyed('My "Gateway" v1.2')]);
    expect(next).toEqual({
      overrides: {},
      tombstones: ['endpoints.custom["My \\"Gateway\\" v1.2"]'],
    });
  });

  it('removes the own entry (every stored spelling) when hiding it, and the array once empty', () => {
    const input = state({ endpoints: { custom: [own('Ollama'), own('ollama')] } });
    const next = tombstoneConfigPaths(input, [keyed('OLLAMA')]);
    expect(next.overrides).toEqual({});
    expect(next.tombstones).toEqual(['endpoints.custom["OLLAMA"]']);
  });

  it('hides a path inside an entry and removes it from the own entry, keeping the rest', () => {
    const input = state({
      endpoints: { custom: [own('gw', { headers: { A: 'a', B: 'b' } }), own('other')] },
    });
    const next = tombstoneConfigPaths(input, [keyed('gw', ['headers', 'A'])]);
    expect(next.overrides).toEqual({
      endpoints: { custom: [own('gw', { headers: { B: 'b' } }), own('other')] },
    });
    expect(next.tombstones).toEqual(['endpoints.custom["gw"].headers.A']);
  });

  it('drops an own entry left holding only its key, which overrides nothing', () => {
    const input = state({ endpoints: { custom: [{ name: 'gw', headers: { A: 'a' } }] } });
    const next = tombstoneConfigPaths(input, [keyed('gw', ['headers', 'A'])]);
    expect(next.overrides).toEqual({});
  });

  it('stores a keyed tombstone once per entry identity and path', () => {
    const input = state({}, ['endpoints.custom["Ollama"].headers']);
    expect(tombstoneConfigPaths(input, [keyed('ollama', ['headers'])]).tombstones).toEqual([
      'endpoints.custom["Ollama"].headers',
    ]);
    expect(tombstoneConfigPaths(input, [keyed('ollama')]).tombstones).toEqual([
      'endpoints.custom["Ollama"].headers',
      'endpoints.custom["ollama"]',
    ]);
  });

  it('refuses a keyed location after an array that is not merged by key', () => {
    const error = (() => {
      try {
        tombstoneConfigPaths(state({}), [
          { segments: ['modelSpecs', 'list'], entry: { key: 'x', rest: [] } },
        ]);
      } catch (caught) {
        return caught;
      }
    })();
    expect(isConfigPathError(error) && error.reason).toBe('keyed_path');
  });

  it('unsets an own entry or a path inside it with the keyed tombstones at or below it', () => {
    const input = state(
      { endpoints: { custom: [own('Ollama', { headers: { A: 'a', B: 'b' } })] } },
      [
        'endpoints.custom["OLLAMA"].headers.A',
        'endpoints.custom["Ollama"].addParams',
        'endpoints.custom["other"].headers.A',
        'endpoints.custom["ollama2"].headers.A',
        'memory.agent',
      ],
    );
    const headers = unsetConfigPaths(input, [keyed('ollama', ['headers'])]);
    expect(headers.overrides).toEqual({ endpoints: { custom: [own('Ollama')] } });
    expect(headers.tombstones).toEqual([
      'endpoints.custom["Ollama"].addParams',
      'endpoints.custom["other"].headers.A',
      'endpoints.custom["ollama2"].headers.A',
      'memory.agent',
    ]);

    const whole = unsetConfigPaths(
      state(
        input.overrides,
        input.tombstones.filter((path) => !path.includes('ollama2')),
      ),
      [keyed('ollama')],
    );
    expect(whole.overrides).toEqual({});
    expect(whole.tombstones).toEqual(['endpoints.custom["other"].headers.A', 'memory.agent']);
  });

  it('clears every keyed tombstone under an unset of the collection or an ancestor', () => {
    const input = state({}, [
      'endpoints.custom["a"]',
      'endpoints.custom["b.c"].headers.X',
      'endpoints.openAI',
    ]);
    expect(unsetConfigPaths(input, [CUSTOM]).tombstones).toEqual(['endpoints.openAI']);
    expect(unsetConfigPaths(input, [['endpoints']]).tombstones).toEqual([]);
    expect(unsetConfigPaths(input, [['endpoints', 'custom', '0']]).tombstones).toEqual(
      input.tombstones,
    );
  });

  it('a write of an entry clears the tombstone that hides it whole, never those inside it', () => {
    const input = state({}, [
      'endpoints.custom["Ollama"]',
      'endpoints.custom["Ollama"].headers.A',
      'endpoints.custom["kept"]',
    ]);
    const written = setConfigFields(input, [{ segments: CUSTOM, value: [own('ollama')] }]);
    expect(written.tombstones).toEqual([
      'endpoints.custom["Ollama"].headers.A',
      'endpoints.custom["kept"]',
    ]);
    const viaSection = setConfigFields(input, [
      { segments: ['endpoints'], value: { custom: [own('kept')] } },
    ]);
    expect(viaSection.tombstones).toEqual([
      'endpoints.custom["Ollama"]',
      'endpoints.custom["Ollama"].headers.A',
    ]);
    expect(getWriteClearedTombstones(input.tombstones, ['endpoints', 'openAI'], {})).toEqual([]);
  });

  it('a write by segments that only spell an entry keeps the keyed tombstones of that entry', () => {
    const input = state({}, [
      'endpoints.custom["GPT"]',
      'endpoints.custom["OR"].headers.X',
      'mcpServers.a["b"]',
    ]);
    const entry = setConfigFields(input, [
      { segments: ['endpoints', 'custom["GPT"]'], value: { titleModel: 'x' } },
    ]);
    expect(entry).toEqual(
      state({ endpoints: { 'custom["GPT"]': { titleModel: 'x' } } }, input.tombstones),
    );
    const header = setConfigFields(input, [
      { segments: ['endpoints', 'custom["OR"]', 'headers', 'X'], value: 'v' },
    ]);
    expect(header.tombstones).toEqual(input.tombstones);
    expect(
      getWriteClearedTombstones(input.tombstones, ['endpoints', 'custom["OR"]', 'headers'], {}),
    ).toEqual([]);
    const legacy = setConfigFields(input, [{ segments: ['mcpServers', 'a["b"]'], value: {} }]);
    expect(legacy.tombstones).toEqual(input.tombstones.slice(0, 2));
  });

  it.each([
    ['a dotted step inside the entry', keyed('K', ['headers', 'a.b']), 'dotted_segment'],
    ['a key step inside the entry', keyed('K', ['headers', 'x["y"]']), 'keyed_path'],
    ['an unsafe step inside the entry', keyed('K', ['__proto__']), 'unsafe_segment'],
    ['an empty step inside the entry', keyed('K', ['headers', '']), 'empty_path'],
    ['an empty key', keyed(''), 'keyed_path'],
    ['an unsafe key', keyed('$where'), 'keyed_path'],
    ['a key past the length limit', keyed('k'.repeat(257)), 'keyed_path'],
    [
      'a key step in the array',
      { segments: ['endpoints', 'custom["x"]'], entry: { key: 'K', rest: [] } },
      'keyed_path',
    ],
    [
      'too deep a path',
      keyed(
        'K',
        Array.from({ length: 30 }, (_, index) => `s${index}`),
      ),
      'too_deep',
    ],
  ])('refuses a keyed location with %s on a hide and a reset', (_label, location, reason) => {
    const input = state({ endpoints: { custom: [own('K', { headers: { 'a.b': 'own' } })] } });
    const refused = (run: () => unknown) => {
      try {
        run();
      } catch (caught) {
        return isConfigPathError(caught) && caught.reason;
      }
      return 'applied';
    };
    expect(refused(() => tombstoneConfigPaths(input, [location]))).toBe(reason);
    expect(refused(() => unsetConfigPaths(input, [location]))).toBe(reason);
  });

  it('moves the keyed tombstones of a renamed entry to its new key, and drops a hide of the new key', () => {
    const input = state({}, [
      'endpoints.custom["ollama"].headers.A',
      'endpoints.custom["Ollama"].addParams',
      'endpoints.custom["Old"].headers.B',
      'endpoints.custom["new"]',
      'endpoints.custom["new"].addParams',
      'endpoints.custom["other"]',
    ]);
    const moved = renameConfigEntryTombstones(input, CUSTOM, 'OLLAMA', 'new');
    expect(moved.tombstones).toEqual([
      'endpoints.custom["new"].headers.A',
      'endpoints.custom["new"].addParams',
      'endpoints.custom["Old"].headers.B',
      'endpoints.custom["other"]',
    ]);
    const untouched = state({}, ['endpoints.custom["other"]']);
    expect(renameConfigEntryTombstones(untouched, CUSTOM, 'old', 'new')).toBe(untouched);
    expect(
      renameConfigEntriesTombstones(input, [{ segments: CUSTOM, from: 'ollama', to: 'new' }]),
    ).toEqual(moved);
  });

  it.each([
    ['an unsafe new name', CUSTOM, '$where'],
    ['a reserved new name', CUSTOM, 'constructor'],
    ['a new name past the length limit', CUSTOM, 'k'.repeat(257)],
    ['a record rather than an array merged by key', ['mcpServers'], 'new'],
  ])('refuses %s instead of moving tombstones no path can address', (_label, segments, to) => {
    const input = state({}, ['endpoints.custom["old"].headers.A']);
    const refused = (run: () => unknown) => {
      try {
        run();
      } catch (caught) {
        return isConfigPathError(caught) && caught.reason;
      }
      return 'applied';
    };

    expect(refused(() => renameConfigEntryTombstones(input, segments, 'old', to))).toBe(
      'keyed_path',
    );
    expect(
      refused(() => renameConfigEntriesTombstones(input, [{ segments, from: 'old', to }])),
    ).toBe('keyed_path');
  });
});
