import {
  getAtPath,
  setAtPath,
  unsetAtPath,
  parseFieldPath,
  isDotFreePath,
  isConfigPathError,
  isSegmentPrefix,
  isEffectivelyEmpty,
  formatTombstonePath,
  pruneEmptyAncestors,
  getClearedTombstones,
  isTombstoneAtOrBelow,
  MAX_CONFIG_PATH_DEPTH,
  parseConfigPathSegments,
  getTombstonePathsToClear,
  parseConfigPath,
  formatKeyedPath,
  isConfigEntryKey,
  isKeyedConfigPath,
  formatConfigLocation,
  MAX_CONFIG_ENTRY_KEY_LENGTH,
} from './paths';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return isConfigPathError(error) ? error.reason : 'unexpected';
  }
  return undefined;
}

describe('setAtPath', () => {
  it('creates missing objects and leaves the input untouched', () => {
    const root = { a: { keep: 1 } };

    const next = setAtPath(root, ['a', 'b', 'c'], 2);

    expect(next).toEqual({ a: { keep: 1, b: { c: 2 } } });
    expect(root).toEqual({ a: { keep: 1 } });
  });

  it('treats a dotted key as one segment', () => {
    const next = setAtPath(
      {},
      ['endpoints', 'bedrock', 'inferenceProfiles', 'us.anthropic.x'],
      'arn',
    );

    expect(next).toEqual({
      endpoints: { bedrock: { inferenceProfiles: { 'us.anthropic.x': 'arn' } } },
    });
  });

  it('replaces or appends array elements by index', () => {
    expect(setAtPath({ list: ['a'] }, ['list', '0'], 'b')).toEqual({ list: ['b'] });
    expect(setAtPath({ list: ['a'] }, ['list', '1'], 'b')).toEqual({ list: ['a', 'b'] });
    expect(setAtPath({ list: [{ x: 1 }] }, ['list', '0', 'y'], 2)).toEqual({
      list: [{ x: 1, y: 2 }],
    });
  });

  it('refuses an index past the end of an array instead of padding it', () => {
    const root = { list: ['a'] };

    expect(reasonOf(() => setAtPath(root, ['list', '2'], 'c'))).toBe('array_index');
    expect(reasonOf(() => setAtPath(root, ['list', '2', 'x'], 1))).toBe('array_index');
    expect(reasonOf(() => setAtPath({ list: [] }, ['list', '10000000'], 'x'))).toBe('array_index');
    expect(reasonOf(() => setAtPath(root, ['list', '9'.repeat(400)], 'x'))).toBe('array_index');
    expect(root).toEqual({ list: ['a'] });
  });

  it('treats a numeric segment below an object or a missing key as a record key', () => {
    expect(setAtPath({ map: {} }, ['map', '10000000'], 1)).toEqual({ map: { '10000000': 1 } });
    expect(setAtPath({}, ['map', '10000000'], 1)).toEqual({ map: { '10000000': 1 } });
  });

  it('refuses to continue below a scalar or null instead of replacing it', () => {
    expect(reasonOf(() => setAtPath({ a: 5 }, ['a', 'b'], 1))).toBe('scalar_parent');
    expect(reasonOf(() => setAtPath({ a: null }, ['a', 'b'], 1))).toBe('scalar_parent');
  });

  it('refuses a named key inside an array and an empty path or segment', () => {
    expect(reasonOf(() => setAtPath({ list: [] }, ['list', 'name'], 1))).toBe('array_key');
    expect(reasonOf(() => setAtPath({}, [], 1))).toBe('empty_path');
    expect(reasonOf(() => setAtPath({}, ['a', ''], 1))).toBe('empty_path');
  });

  it('stores a `__proto__` segment as an own key without touching any prototype', () => {
    const next = setAtPath({}, ['headers', '__proto__'], { polluted: true });

    expect(Object.prototype.hasOwnProperty.call(next.headers, '__proto__')).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('unsetAtPath', () => {
  it('removes a key and copies only the path it changes', () => {
    const sibling = { untouched: true };
    const root = { a: { b: 1, c: 2 }, sibling };

    const next = unsetAtPath(root, ['a', 'b']);

    expect(next).toEqual({ a: { c: 2 }, sibling });
    expect(next.sibling).toBe(sibling);
    expect(root.a).toEqual({ b: 1, c: 2 });
  });

  it('returns the input for a missing path', () => {
    const root = { a: { b: 1 } };

    expect(unsetAtPath(root, ['a', 'x', 'y'])).toBe(root);
    expect(unsetAtPath(root, ['a', 'b', 'c'])).toBe(root);
  });

  it('removes inside array elements but refuses to remove an element itself', () => {
    const root = { custom: [{ name: 'a', headers: { A: '1', B: '2' } }] };

    expect(unsetAtPath(root, ['custom', '0', 'headers', 'A'])).toEqual({
      custom: [{ name: 'a', headers: { B: '2' } }],
    });
    expect(reasonOf(() => unsetAtPath(root, ['custom', '0']))).toBe('array_element');
    expect(unsetAtPath(root, ['custom', '5'])).toBe(root);
  });
});

describe('pruneEmptyAncestors', () => {
  it('removes the chain of emptied objects up to the section', () => {
    expect(pruneEmptyAncestors({ balance: {} }, ['balance', 'startBalance'])).toEqual({});
    expect(pruneEmptyAncestors({ a: { b: { c: {} } } }, ['a', 'b', 'c', 'd'])).toEqual({});
  });

  it('stops at the first ancestor that still holds a value', () => {
    expect(pruneEmptyAncestors({ a: { b: {}, keep: 1 } }, ['a', 'b', 'c'])).toEqual({
      a: { keep: 1 },
    });
  });

  it('never removes an array element', () => {
    expect(
      pruneEmptyAncestors({ custom: [{ headers: {} }] }, ['custom', '0', 'headers', 'A']),
    ).toEqual({ custom: [{}] });
    expect(pruneEmptyAncestors({ custom: [{}] }, ['custom', '0', 'x'])).toEqual({ custom: [{}] });
  });
});

describe('tombstone addressing', () => {
  it('formats dot-free segments and refuses a dotted one', () => {
    expect(formatTombstonePath(['mcpServers', 'github'])).toBe('mcpServers.github');
    expect(reasonOf(() => formatTombstonePath(['endpoints', 'gpt-4.1']))).toBe('dotted_segment');
  });

  it('clears the written path and its ancestors below the section', () => {
    expect(getTombstonePathsToClear('memory')).toEqual(['memory']);
    expect(getTombstonePathsToClear('memory.agent.provider')).toEqual([
      'memory.agent',
      'memory.agent.provider',
    ]);
  });

  it('clears only the dot-free prefix of a path with a dotted segment', () => {
    expect(
      getClearedTombstones(['endpoints', 'azureOpenAI', 'models', 'gpt-4.1', 'deploymentName']),
    ).toEqual(['endpoints.azureOpenAI', 'endpoints.azureOpenAI.models']);
  });

  it('matches tombstones at or below a path segment by segment', () => {
    expect(isTombstoneAtOrBelow('mcpServers.github', ['mcpServers'])).toBe(true);
    expect(isTombstoneAtOrBelow('mcpServers.github', ['mcpServers', 'github'])).toBe(true);
    expect(isTombstoneAtOrBelow('mcpServers.githubber', ['mcpServers', 'github'])).toBe(false);
    expect(isTombstoneAtOrBelow('a.b.c', ['a', 'b.c'])).toBe(false);
    expect(isSegmentPrefix(['a'], ['a', 'b'])).toBe(true);
    expect(isSegmentPrefix(['a', 'b'], ['a'])).toBe(false);
  });
});

describe('getAtPath and isEffectivelyEmpty', () => {
  it('reads own keys only', () => {
    expect(getAtPath({ a: [{ 'b.c': 1 }] }, ['a', '0', 'b.c'])).toBe(1);
    expect(getAtPath({}, ['toString'])).toBeUndefined();
    expect(getAtPath({ a: 1 }, parseFieldPath('a.b'))).toBeUndefined();
  });

  it('treats objects holding only empty objects as empty', () => {
    expect(isEffectivelyEmpty({})).toBe(true);
    expect(isEffectivelyEmpty({ a: {}, b: { c: {} } })).toBe(true);
    expect(isEffectivelyEmpty({ a: { b: false } })).toBe(false);
    expect(isEffectivelyEmpty({ a: [] })).toBe(false);
  });
});

describe('client segment paths', () => {
  it('accepts keys that contain dots or `$` past the first character, as one segment each', () => {
    const segments = [
      'endpoints',
      'bedrock',
      'inferenceProfiles',
      'us.anthropic.claude-sonnet-4-5',
    ];
    const parsed = parseConfigPathSegments(segments);

    expect(parsed).toEqual({ ok: true, segments });
    expect(parsed.ok && parsed.segments).not.toBe(segments);
    expect(parseConfigPathSegments(['addParams', 'price$'])).toEqual({
      ok: true,
      segments: ['addParams', 'price$'],
    });
    expect(isDotFreePath(segments)).toBe(false);
    expect(isDotFreePath(['interface', 'customWelcome'])).toBe(true);
  });

  it.each([
    ['not an array', 'interface.customWelcome', 'empty_path'],
    ['an empty list', [], 'empty_path'],
    ['an empty segment', ['interface', ''], 'empty_path'],
    ['a non-string segment', ['endpoints', 'custom', 0], 'empty_path'],
    ['a `$` key', ['interface', '$set'], 'unsafe_segment'],
    ['`__proto__`', ['__proto__', 'polluted'], 'unsafe_segment'],
    ['`constructor`', ['interface', 'constructor'], 'unsafe_segment'],
    ['`prototype`', ['prototype'], 'unsafe_segment'],
    ['a path deeper than the limit', Array(MAX_CONFIG_PATH_DEPTH + 1).fill('a'), 'too_deep'],
  ])('refuses %s', (_label, value, reason) => {
    expect(parseConfigPathSegments(value)).toEqual({ ok: false, reason });
  });

  it('accepts a path exactly at the depth limit', () => {
    expect(parseConfigPathSegments(Array(MAX_CONFIG_PATH_DEPTH).fill('a')).ok).toBe(true);
  });
});

describe('keyed config paths', () => {
  const CUSTOM = ['endpoints', 'custom'];

  it('reads a dotted path as its segments and a keyed one as an entry and a path inside it', () => {
    expect(parseConfigPath('mcpServers.github.headers')).toEqual({
      segments: ['mcpServers', 'github', 'headers'],
    });
    expect(parseConfigPath('endpoints.custom["Gateway"]')).toEqual({
      segments: CUSTOM,
      entry: { key: 'Gateway', rest: [] },
    });
    expect(parseConfigPath('endpoints.custom["Gateway"].headers.X-Key')).toEqual({
      segments: CUSTOM,
      entry: { key: 'Gateway', rest: ['headers', 'X-Key'] },
    });
  });

  it('takes any character in a key, since it is a JSON string, and round-trips it', () => {
    const names = [
      'My Endpoint',
      'api.example.com',
      'quote " inside',
      'bracket ] and [ "',
      'back\\slash',
      'trailing.',
      'a..b',
      'cost$',
      'Ünïcødé 名前 🚀',
      'line\nbreak',
    ];
    for (const name of names) {
      const path = formatKeyedPath(CUSTOM, name, ['headers', 'X-Key']);
      expect(isKeyedConfigPath(path)).toBe(true);
      expect(parseConfigPath(path)).toEqual({
        segments: CUSTOM,
        entry: { key: name, rest: ['headers', 'X-Key'] },
      });
    }
    expect(parseConfigPath('endpoints.custom["\\u0041"]')?.entry?.key).toBe('A');
    expect(formatKeyedPath(CUSTOM, 'A')).toBe('endpoints.custom["A"]');
  });

  it('refuses a malformed keyed path instead of reading part of it', () => {
    const malformed = [
      'endpoints.custom["Gateway"',
      'endpoints.custom["Gateway]',
      'endpoints.custom["Gateway"]headers',
      'endpoints.custom["Gateway"].',
      'endpoints.custom["Gateway"]..headers',
      'endpoints.custom["a"]["b"]',
      'endpoints.custom["a"].headers["b"]',
      'endpoints.custom[""]',
      '["Gateway"]',
      '.custom["Gateway"]',
      'endpoints..custom["Gateway"]',
      'endpoints.custom["__proto__"]',
      'endpoints.custom["constructor"]',
      'endpoints.custom["$where"]',
      'endpoints.custom["Gateway"].__proto__',
      'endpoints.custom["Gateway"].$set',
      'endpoints.$custom["Gateway"]',
      'endpoints.custom["bad \\x escape"]',
      `endpoints.custom[${JSON.stringify('n'.repeat(MAX_CONFIG_ENTRY_KEY_LENGTH + 1))}]`,
      `endpoints.custom["a"].${Array.from({ length: MAX_CONFIG_PATH_DEPTH }, () => 'x').join('.')}`,
    ];
    for (const path of malformed) {
      expect(parseConfigPath(path)).toBeNull();
    }
    expect(parseConfigPath(`endpoints.custom[${JSON.stringify('n'.repeat(256))}]`)).not.toBeNull();
    expect(isConfigEntryKey('$x')).toBe(false);
    expect(isConfigEntryKey('x$')).toBe(true);
  });

  it('treats only `["` as a key step, so other brackets stay part of a dotted key', () => {
    expect(isKeyedConfigPath('endpoints.custom[0]')).toBe(false);
    expect(parseConfigPath('endpoints.custom[0]')).toEqual({
      segments: ['endpoints', 'custom[0]'],
    });
  });

  it('never stores a dotted tombstone a later read would take for a keyed one', () => {
    expect(reasonOf(() => formatTombstonePath(['endpoints', 'custom["x"]']))).toBe('keyed_path');
    expect(formatConfigLocation({ segments: CUSTOM, entry: { key: 'x', rest: ['a'] } })).toBe(
      'endpoints.custom["x"].a',
    );
    expect(formatConfigLocation({ segments: ['memory', 'agent'] })).toBe('memory.agent');
  });
});
