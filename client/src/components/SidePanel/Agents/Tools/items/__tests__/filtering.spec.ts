import type { AgentItem } from '../types';
import { makePlugin, makeSkill } from 'test/itemFactories';
import { applyFilter, matchesView } from '../filtering';

const items: AgentItem[] = [
  {
    kind: 'builtin',
    id: 'execute_code',
    name: 'Code Interpreter',
    description: 'Run Python',
    iconKey: 'execute_code',
  },
  {
    kind: 'tool',
    id: 'dalle',
    name: 'DALL-E',
    description: 'Generate images',
    iconKey: 'tool',
    plugin: makePlugin({ pluginKey: 'dalle' }),
  },
  {
    kind: 'skill',
    id: 's1',
    name: 'Code Reviewer',
    description: 'Review PRs',
    iconKey: 'skill',
    skill: makeSkill({ _id: 's1', name: 'Code Reviewer', category: 'code' }),
    ownedByUser: true,
  },
  {
    kind: 'skill',
    id: 's2',
    name: 'Marketing Email',
    description: 'Write emails',
    iconKey: 'skill',
    skill: makeSkill({ _id: 's2', name: 'Marketing Email', category: 'marketing' }),
    ownedByUser: false,
  },
];

describe('applyFilter', () => {
  test('no filter returns all items', () => {
    expect(applyFilter(items, {}).length).toBe(4);
  });

  test('search filters by name', () => {
    const result = applyFilter(items, { search: 'code' });
    expect(result.map((i) => i.id)).toEqual(['execute_code', 's1']);
  });

  test('search is case-insensitive across name and description', () => {
    const result = applyFilter(items, { search: 'IMAGES' });
    expect(result.map((i) => i.id)).toEqual(['dalle']);
  });

  test('kind filter restricts to one type', () => {
    const result = applyFilter(items, { kind: 'skill' });
    expect(result.map((i) => i.id)).toEqual(['s1', 's2']);
  });

  test('"all" kind is equivalent to no filter', () => {
    expect(applyFilter(items, { kind: 'all' }).length).toBe(4);
  });

  test('category filters skills by their category', () => {
    const result = applyFilter(items, { category: 'marketing' });
    expect(result.map((i) => i.id)).toEqual(['s2']);
  });

  test('combined filters apply intersection', () => {
    const result = applyFilter(items, { kind: 'skill', search: 'code' });
    expect(result.map((i) => i.id)).toEqual(['s1']);
  });

  test('marketplace view returns all items', () => {
    expect(applyFilter(items, { view: 'marketplace' }).length).toBe(4);
  });

  test('"mine" view returns only items owned by the user', () => {
    const result = applyFilter(items, { view: 'mine' });
    expect(result.map((i) => i.id)).toEqual(['s1']);
  });

  test('"favorites" view returns only items matching compound kind:id keys', () => {
    const result = applyFilter(
      items,
      { view: 'favorites' },
      { favoritedIds: new Set(['tool:dalle']) },
    );
    expect(result.map((i) => i.id)).toEqual(['dalle']);
  });

  test('"favorites" view does not match bare ids (cross-kind collision guard)', () => {
    const result = applyFilter(items, { view: 'favorites' }, { favoritedIds: new Set(['dalle']) });
    expect(result.length).toBe(0);
  });

  test('"favorites" view distinguishes the same id across kinds', () => {
    const collision: AgentItem[] = [
      {
        kind: 'tool',
        id: 'shared-id',
        name: 'Tool',
        description: '',
        iconKey: 'tool',
        plugin: makePlugin({ pluginKey: 'shared-id' }),
      },
      {
        kind: 'skill',
        id: 'shared-id',
        name: 'Skill',
        description: '',
        iconKey: 'skill',
        skill: makeSkill({ _id: 'shared-id' }),
      },
    ];
    const result = applyFilter(
      collision,
      { view: 'favorites' },
      { favoritedIds: new Set(['skill:shared-id']) },
    );
    expect(result.map((i) => i.kind)).toEqual(['skill']);
  });

  test('"favorites" view with no favorited set returns nothing', () => {
    expect(applyFilter(items, { view: 'favorites' }).length).toBe(0);
  });

  test('view filter intersects with kind and search', () => {
    const result = applyFilter(items, { view: 'mine', kind: 'skill', search: 'reviewer' });
    expect(result.map((i) => i.id)).toEqual(['s1']);
  });
});

describe('matchesView', () => {
  const ownedSkill = items[2];
  const unownedSkill = items[3];
  const tool = items[1];

  test('marketplace view matches everything', () => {
    expect(matchesView(tool, 'marketplace', {})).toBe(true);
    expect(matchesView(ownedSkill, 'marketplace', {})).toBe(true);
  });

  test('undefined view matches everything', () => {
    expect(matchesView(tool, undefined, {})).toBe(true);
  });

  test('"mine" matches only items flagged ownedByUser', () => {
    expect(matchesView(ownedSkill, 'mine', {})).toBe(true);
    expect(matchesView(unownedSkill, 'mine', {})).toBe(false);
    expect(matchesView(tool, 'mine', {})).toBe(false);
  });

  test('"favorites" matches only compound keys in the favorited set', () => {
    const context = { favoritedIds: new Set(['skill:s1']) };
    expect(matchesView(ownedSkill, 'favorites', context)).toBe(true);
    expect(matchesView(unownedSkill, 'favorites', context)).toBe(false);
  });

  test('"favorites" matches nothing without a favorited set', () => {
    expect(matchesView(ownedSkill, 'favorites', {})).toBe(false);
  });
});
