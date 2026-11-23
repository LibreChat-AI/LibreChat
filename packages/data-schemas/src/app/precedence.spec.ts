import { PrincipalType } from 'librechat-data-provider';
import type { ConfigPrecedenceKey } from './precedence';
import {
  BASE_CONFIG_PRIORITY,
  isBaseConfigPrincipal,
  sortByConfigPrecedence,
  compareConfigPrecedence,
  getDefaultConfigPriority,
} from './precedence';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';

function layer(
  principalType: PrincipalType,
  principalId: string,
  priority: number,
  _id?: string,
): ConfigPrecedenceKey {
  return { principalType, principalId, priority, _id };
}

const ids = (layers: ConfigPrecedenceKey[]): string[] =>
  layers.map(({ principalType, principalId }) => `${principalType}:${principalId}`);

/** Deterministic Fisher-Yates shuffle, so a failure reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let index = result.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

describe('compareConfigPrecedence', () => {
  it('merges Base first whatever its priority', () => {
    const base = layer(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, 50, 'a');
    const role = layer(PrincipalType.ROLE, 'editor', 5, 'b');

    expect(ids(sortByConfigPrecedence([role, base]))).toEqual([
      `role:${BASE_CONFIG_PRINCIPAL_ID}`,
      'role:editor',
    ]);
  });

  it('orders by priority, then role < group < user, then identity', () => {
    const layers = [
      layer(PrincipalType.USER, 'u1', 10, 'c'),
      layer(PrincipalType.GROUP, 'g2', 10, 'b'),
      layer(PrincipalType.GROUP, 'g1', 10, 'f'),
      layer(PrincipalType.ROLE, 'editor', 10, 'e'),
      layer(PrincipalType.ROLE, 'viewer', 5, 'z'),
      layer(PrincipalType.USER, 'u2', 1, 'a'),
    ];

    expect(ids(sortByConfigPrecedence(layers))).toEqual([
      'user:u2',
      'role:viewer',
      'role:editor',
      'group:g2',
      'group:g1',
      'user:u1',
    ]);
  });

  it('gives the same order for every input order', () => {
    const layers = [
      layer(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, 30, '07'),
      layer(PrincipalType.GROUP, 'g1', 20, '03'),
      layer(PrincipalType.GROUP, 'g2', 20, '01'),
      layer(PrincipalType.GROUP, 'g3', 20, '05'),
      layer(PrincipalType.ROLE, 'editor', 20, '09'),
      layer(PrincipalType.USER, 'u1', 20, '02'),
    ];
    const expected = ids(sortByConfigPrecedence(layers));

    for (let seed = 1; seed <= 20; seed++) {
      expect(ids(sortByConfigPrecedence(shuffled(layers, seed)))).toEqual(expected);
    }
    expect(expected).toEqual([
      `role:${BASE_CONFIG_PRINCIPAL_ID}`,
      'role:editor',
      'group:g2',
      'group:g1',
      'group:g3',
      'user:u1',
    ]);
  });

  it('treats only the role principal named __base__ as Base', () => {
    const group = layer(PrincipalType.GROUP, BASE_CONFIG_PRINCIPAL_ID, 50);
    const role = layer(PrincipalType.ROLE, 'editor', 5);

    expect(isBaseConfigPrincipal(group)).toBe(false);
    expect(compareConfigPrecedence(group, role)).toBeGreaterThan(0);
  });

  it('keeps documents without an identity in their input order on a full tie', () => {
    const first = layer(PrincipalType.ROLE, 'a', 10);
    const second = layer(PrincipalType.ROLE, 'b', 10);

    expect(compareConfigPrecedence(first, second)).toBe(0);
    expect(ids(sortByConfigPrecedence([second, first]))).toEqual(['role:b', 'role:a']);
  });
});

describe('getDefaultConfigPriority', () => {
  it('ranks a narrower principal higher, and sits Base at the bottom', () => {
    expect(getDefaultConfigPriority({ principalType: PrincipalType.ROLE, principalId: 'x' })).toBe(
      10,
    );
    expect(getDefaultConfigPriority({ principalType: PrincipalType.GROUP, principalId: 'x' })).toBe(
      20,
    );
    expect(getDefaultConfigPriority({ principalType: PrincipalType.USER, principalId: 'x' })).toBe(
      100,
    );
    expect(
      getDefaultConfigPriority({
        principalType: PrincipalType.ROLE,
        principalId: BASE_CONFIG_PRINCIPAL_ID,
      }),
    ).toBe(BASE_CONFIG_PRIORITY);
  });
});
