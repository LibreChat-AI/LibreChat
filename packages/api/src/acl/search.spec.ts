import { logger } from '@librechat/data-schemas';
import { Permissions, SystemRoles, PrincipalType, PermissionTypes } from 'librechat-data-provider';
import type { TPrincipalSearchResult } from 'librechat-data-provider';
import type { Response } from 'express';
import type {
  PrincipalSearchDeps,
  PrincipalSearchRequest,
  SearchablePrincipalType,
} from './search';
import {
  createPrincipalSearch,
  createPeoplePickerAccess,
  getRequestedPrincipalTypes,
  getEntraPrincipalSearchType,
} from './search';

type PickerPermissions = {
  [Permissions.VIEW_USERS]?: boolean;
  [Permissions.VIEW_GROUPS]?: boolean;
  [Permissions.VIEW_ROLES]?: boolean;
};

type Query = PrincipalSearchRequest['query'];

const { USER, GROUP, ROLE } = PrincipalType;

const permissionsFor = (types: SearchablePrincipalType[]): PickerPermissions => ({
  [Permissions.VIEW_USERS]: types.includes(USER),
  [Permissions.VIEW_GROUPS]: types.includes(GROUP),
  [Permissions.VIEW_ROLES]: types.includes(ROLE),
});

const setup = ({
  query = {},
  role = SystemRoles.USER,
  picker,
  getRoleByName = jest.fn(async () => ({
    permissions: picker ? { [PermissionTypes.PEOPLE_PICKER]: picker } : {},
  })),
}: {
  query?: Query;
  role?: string | null;
  picker?: PickerPermissions;
  getRoleByName?: jest.Mock;
}) => {
  const req = { user: role ? { id: 'user123', role } : undefined, query } as PrincipalSearchRequest;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  const middleware = createPeoplePickerAccess({ getRoleByName });
  return {
    req,
    res,
    next,
    getRoleByName,
    run: () => middleware(req, res as unknown as Response, next),
  };
};

const outcomeOf = ({ req, res, next }: ReturnType<typeof setup>) => ({
  status: res.status.mock.calls[0]?.[0],
  body: res.json.mock.calls[0]?.[0],
  nextCalls: next.mock.calls.length,
  types: req.principalSearchTypes,
});

const forbidden = (message: string) => ({
  status: 403,
  body: { error: 'Forbidden', message },
  nextCalls: 0,
  types: undefined,
});

const allowed = (types: SearchablePrincipalType[]) => ({
  status: undefined,
  body: undefined,
  nextCalls: 1,
  types,
});

describe('getRequestedPrincipalTypes', () => {
  it.each([
    [{}, []],
    [{ type: GROUP }, [GROUP]],
    [{ types: `${USER},${ROLE}` }, [USER, ROLE]],
    [{ types: [GROUP, `${ROLE},${USER}`] }, [GROUP, ROLE, USER]],
    [{ type: USER, types: `${GROUP},${USER}` }, [USER, GROUP]],
    [{ types: `${PrincipalType.PUBLIC},foobar,` }, []],
    [{ types: { nested: USER } }, []],
    [{ type: [{ nested: USER }] }, []],
  ])('reads %j as %j', (query, expected) => {
    expect(getRequestedPrincipalTypes(query)).toEqual(expected);
  });
});

describe('getEntraPrincipalSearchType', () => {
  it.each([
    [[USER, GROUP, ROLE], 'all'],
    [[USER, GROUP], 'all'],
    [[USER, ROLE], 'users'],
    [[USER], 'users'],
    [[GROUP, ROLE], 'groups'],
    [[GROUP], 'groups'],
    [[ROLE], null],
    [[], null],
  ])('maps %j to %s', (types, expected) => {
    expect(getEntraPrincipalSearchType(types as SearchablePrincipalType[])).toBe(expected);
  });
});

describe('createPeoplePickerAccess', () => {
  it('returns 401 if user is not authenticated', async () => {
    const test = setup({ role: null });
    await test.run();

    expect(test.res.status).toHaveBeenCalledWith(401);
    expect(test.res.json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    expect(test.next).not.toHaveBeenCalled();
  });

  it('returns 403 if role has no permissions', async () => {
    const test = setup({ getRoleByName: jest.fn(async () => null) });
    await test.run();

    expect(outcomeOf(test)).toEqual(forbidden('No permissions configured for user role'));
  });

  it('allows a literal admin every type without loading the role', async () => {
    const test = setup({ role: SystemRoles.ADMIN });
    await test.run();

    expect(outcomeOf(test)).toEqual(allowed([USER, GROUP, ROLE]));
    expect(test.getRoleByName).not.toHaveBeenCalled();
  });

  it('narrows a literal admin search to the requested types', async () => {
    const test = setup({ role: SystemRoles.ADMIN, query: { type: GROUP } });
    await test.run();

    expect(outcomeOf(test)).toEqual(allowed([GROUP]));
  });

  it.each<[Query, SearchablePrincipalType[], SearchablePrincipalType[]]>([
    [{ type: USER }, [USER], [USER]],
    [{ type: GROUP }, [GROUP], [GROUP]],
    [{ type: ROLE }, [ROLE], [ROLE]],
    [{ types: `${USER},${GROUP}` }, [USER, GROUP], [USER, GROUP]],
    [{ types: GROUP }, [GROUP, ROLE], [GROUP]],
  ])('allows %j for a role permitting %j', async (query, permitted, expected) => {
    const test = setup({ query, picker: permissionsFor(permitted) });
    await test.run();

    expect(outcomeOf(test)).toEqual(allowed(expected));
  });

  it.each<[Query, SearchablePrincipalType[], string]>([
    [{ type: USER }, [GROUP, ROLE], 'users'],
    [{ type: GROUP }, [USER, ROLE], 'groups'],
    [{ type: ROLE }, [USER, GROUP], 'roles'],
    [{ types: GROUP }, [USER], 'groups'],
    [{ types: `${USER},${ROLE}` }, [USER], 'roles'],
    [{ types: [GROUP, ROLE] }, [USER, ROLE], 'groups'],
    [{ type: USER, types: GROUP }, [USER], 'groups'],
    [{ type: USER }, [], 'users'],
  ])('denies %j for a role permitting %j', async (query, permitted, label) => {
    const test = setup({ query, picker: permissionsFor(permitted) });
    await test.run();

    expect(outcomeOf(test)).toEqual(forbidden(`Insufficient permissions to search for ${label}`));
  });

  it.each<[Query, SearchablePrincipalType[]]>([
    [{}, [GROUP]],
    [{}, [ROLE]],
    [{}, [USER, ROLE]],
    [{}, [USER, GROUP, ROLE]],
    [{ types: '' }, [GROUP]],
    [{ types: 'foobar' }, [USER]],
    [{ types: PrincipalType.PUBLIC }, [GROUP, ROLE]],
    [{ types: { nested: USER } }, [GROUP]],
  ])(
    'limits an unfiltered search %j to the %j types the role permits',
    async (query, permitted) => {
      const test = setup({ query, picker: permissionsFor(permitted) });
      await test.run();

      expect(outcomeOf(test)).toEqual(allowed(permitted));
    },
  );

  it.each([{}, { types: '' }, { types: 'foobar' }])(
    'denies an unfiltered search %j when the role permits no types',
    async (query) => {
      const test = setup({ query, picker: permissionsFor([]) });
      await test.run();

      expect(outcomeOf(test)).toEqual(
        forbidden('Insufficient permissions to search for users, groups, or roles'),
      );
    },
  );

  it('denies a requested type when the role has no people picker permissions', async () => {
    const test = setup({ query: { type: USER } });
    await test.run();

    expect(outcomeOf(test)).toEqual(forbidden('Insufficient permissions to search for users'));
  });

  it('handles errors gracefully', async () => {
    const error = new Error('Database error');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const test = setup({ getRoleByName: jest.fn().mockRejectedValue(error) });
    await test.run();

    expect(errorSpy).toHaveBeenCalledWith(
      '[checkPeoplePickerAccess][user123] error for type=undefined, types=undefined',
      error,
    );
    expect(test.res.status).toHaveBeenCalledWith(500);
    expect(test.res.json).toHaveBeenCalledWith({
      error: 'Internal Server Error',
      message: 'Failed to check permissions',
    });
    expect(test.next).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('createPrincipalSearch', () => {
  type ScoredResults = Parameters<PrincipalSearchDeps['sortPrincipalsByRelevance']>[0];

  const principal = (overrides: Partial<TPrincipalSearchResult>): TPrincipalSearchResult => ({
    type: USER,
    name: 'Principal',
    source: 'local',
    ...overrides,
  });

  const setupSearch = ({
    query = { q: 'alice' },
    types,
    entraEnabled = false,
    authorization = 'Bearer token',
    localResults = [],
    entraResults = [],
  }: {
    query?: Query;
    types?: SearchablePrincipalType[];
    entraEnabled?: boolean;
    authorization?: string;
    localResults?: TPrincipalSearchResult[];
    entraResults?: TPrincipalSearchResult[];
  }) => {
    const deps = {
      searchPrincipals: jest.fn(async () => localResults),
      calculateRelevanceScore: jest.fn((item: TPrincipalSearchResult) => item.name.length),
      sortPrincipalsByRelevance: jest.fn((results: ScoredResults) =>
        [...results].sort((a, b) => b._searchScore - a._searchScore),
      ),
      entraIdPrincipalFeatureEnabled: jest.fn(() => entraEnabled),
      searchEntraIdPrincipals: jest.fn(async () => entraResults),
    };
    const req = {
      query,
      headers: { authorization },
      user: { id: 'user123', role: SystemRoles.USER, openidId: 'oid-1' },
      principalSearchTypes: types,
    } as PrincipalSearchRequest;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const search = createPrincipalSearch(deps);
    return { deps, req, res, run: () => search(req, res as unknown as Response) };
  };

  it.each([{}, { q: ['alice'] }, { q: '   ' }])('rejects the query %j', async (query) => {
    const test = setupSearch({ query, types: [USER] });
    await test.run();

    expect(test.res.status).toHaveBeenCalledWith(400);
    expect(test.res.json).toHaveBeenCalledWith({
      error: 'Query parameter "q" is required and must not be empty',
    });
    expect(test.deps.searchPrincipals).not.toHaveBeenCalled();
  });

  it('rejects a one-character query', async () => {
    const test = setupSearch({ query: { q: ' a ' }, types: [USER] });
    await test.run();

    expect(test.res.status).toHaveBeenCalledWith(400);
    expect(test.res.json).toHaveBeenCalledWith({
      error: 'Query must be at least 2 characters long',
    });
    expect(test.deps.searchPrincipals).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 20],
    ['5', 5],
    ['500', 50],
    ['0', 10],
    ['-3', 1],
    ['abc', 10],
  ])('searches the trimmed literal query with limit %s as %d', async (limit, expected) => {
    const test = setupSearch({ query: { q: '  [invalid  ', limit }, types: [USER] });
    await test.run();

    expect(test.deps.searchPrincipals).toHaveBeenCalledWith('[invalid', expected, [USER]);
    expect(test.res.status).toHaveBeenCalledWith(200);
    expect(test.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ query: '[invalid', limit: expected }),
    );
  });

  it('searches only the resolved types, ignoring the query filter', async () => {
    const test = setupSearch({ query: { q: 'alice', type: USER, types: USER }, types: [GROUP] });
    await test.run();

    expect(test.deps.searchPrincipals).toHaveBeenCalledWith('alice', 20, [GROUP]);
    expect(test.res.json).toHaveBeenCalledWith(expect.objectContaining({ types: [GROUP] }));
  });

  it('searches no types when the access check did not run', async () => {
    const test = setupSearch({ query: { q: 'alice', types: USER }, entraEnabled: true });
    await test.run();

    expect(test.deps.searchPrincipals).toHaveBeenCalledWith('alice', 20, []);
    expect(test.deps.searchEntraIdPrincipals).not.toHaveBeenCalled();
    expect(test.res.status).toHaveBeenCalledWith(200);
  });

  it.each<[SearchablePrincipalType[], string | null]>([
    [[USER, GROUP, ROLE], 'all'],
    [[USER, ROLE], 'users'],
    [[GROUP, ROLE], 'groups'],
    [[ROLE], null],
  ])('scopes the Entra ID search for %j to %s', async (types, graphType) => {
    const test = setupSearch({
      types,
      entraEnabled: true,
      localResults: [principal({ name: 'Alice Local', email: 'alice@local.test' })],
    });
    await test.run();

    if (graphType) {
      expect(test.deps.searchEntraIdPrincipals).toHaveBeenCalledWith(
        'token',
        'oid-1',
        'alice',
        graphType,
        19,
      );
    } else {
      expect(test.deps.searchEntraIdPrincipals).not.toHaveBeenCalled();
    }
    expect(test.res.status).toHaveBeenCalledWith(200);
  });

  it.each([
    ['Entra ID search is disabled', { entraEnabled: false }],
    ['there is no bearer token', { authorization: 'Basic token' }],
    [
      'local results fill the limit',
      { query: { q: 'alice', limit: '1' }, localResults: [principal({ name: 'Alice' })] },
    ],
  ])('skips Entra ID search when %s', async (_case, overrides) => {
    const test = setupSearch({ types: [USER, GROUP], entraEnabled: true, ...overrides });
    await test.run();

    expect(test.deps.searchEntraIdPrincipals).not.toHaveBeenCalled();
    expect(test.res.status).toHaveBeenCalledWith(200);
  });

  it('merges new Entra ID principals, ranks them, and counts sources', async () => {
    const test = setupSearch({
      types: [USER, GROUP],
      entraEnabled: true,
      localResults: [
        principal({ name: 'Alice', email: 'alice@example.test' }),
        principal({ type: GROUP, name: 'Admins', idOnTheSource: 'group-1' }),
      ],
      entraResults: [
        principal({ name: 'Alice Entra', email: 'ALICE@example.test', source: 'entra' }),
        principal({ type: GROUP, name: 'Admins Entra', idOnTheSource: 'group-1', source: 'entra' }),
        principal({ name: 'Alexandra', email: 'alexandra@example.test', source: 'entra' }),
      ],
    });
    await test.run();

    expect(test.res.json).toHaveBeenCalledWith({
      query: 'alice',
      limit: 20,
      types: [USER, GROUP],
      results: [
        principal({ name: 'Alexandra', email: 'alexandra@example.test', source: 'entra' }),
        principal({ type: GROUP, name: 'Admins', idOnTheSource: 'group-1' }),
        principal({ name: 'Alice', email: 'alice@example.test' }),
      ],
      count: 3,
      sources: { local: 2, entra: 1 },
    });
  });

  it('falls back to local results when Entra ID search fails', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const local = principal({ name: 'Alice' });
    const test = setupSearch({ types: [USER], entraEnabled: true, localResults: [local] });
    test.deps.searchEntraIdPrincipals.mockRejectedValue(new Error('graph unavailable'));
    await test.run();

    expect(warnSpy).toHaveBeenCalledWith(
      'Graph API search failed, falling back to local results:',
      'graph unavailable',
    );
    expect(test.res.status).toHaveBeenCalledWith(200);
    expect(test.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ results: [local], sources: { local: 1, entra: 0 } }),
    );
    warnSpy.mockRestore();
  });

  it('does not expose internal error details on search failures', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const test = setupSearch({ types: [USER] });
    const error = new Error('database failure with internal detail');
    test.deps.searchPrincipals.mockRejectedValue(error);
    await test.run();

    expect(errorSpy).toHaveBeenCalledWith('Error searching principals:', error);
    expect(test.res.status).toHaveBeenCalledWith(500);
    expect(test.res.json).toHaveBeenCalledWith({ error: 'Failed to search principals' });
    errorSpy.mockRestore();
  });

  it.each<Query>([{ q: 'alice', type: GROUP }, { q: 'alice', types: 'foobar' }, { q: 'alice' }])(
    'searches local and Entra ID groups only for a groups-only role requesting %j',
    async (query) => {
      const test = setupSearch({ query, entraEnabled: true });
      const search = createPrincipalSearch(test.deps);
      const checkAccess = createPeoplePickerAccess({
        getRoleByName: async () => ({
          permissions: { [PermissionTypes.PEOPLE_PICKER]: permissionsFor([GROUP]) },
        }),
      });
      await checkAccess(test.req, test.res as unknown as Response, () =>
        search(test.req, test.res as unknown as Response),
      );

      expect(test.deps.searchPrincipals).toHaveBeenCalledWith('alice', 20, [GROUP]);
      expect(test.deps.searchEntraIdPrincipals).toHaveBeenCalledWith(
        'token',
        'oid-1',
        'alice',
        'groups',
        20,
      );
    },
  );
});
