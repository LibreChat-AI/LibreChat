import { PrincipalType } from 'librechat-data-provider';
import { Client, RetryHandlerOptions } from '@microsoft/microsoft-graph-client';
import {
  ensureDirectoryPrincipalUser,
  preparePermissionPrincipals,
  DirectoryVerificationError,
  PrincipalPreparationError,
  refreshDirectoryGroupMembers,
  resolveDirectoryPrincipal,
  validateLocalPrincipalId,
} from './principals';
import { permissionErrorCode } from './accessControlService';

function graphRequest<T>(select: () => T) {
  return {
    select,
    options(_options: { signal: AbortSignal }) {
      return this;
    },
    middlewareOptions(_options: object[]) {
      return this;
    },
  };
}

const principal = {
  type: PrincipalType.USER,
  name: 'Directory User',
  email: 'Directory-User@Example.com',
  idOnTheSource: 'directory-user-id',
};
const authContext = { accessToken: 'test-token', sub: 'test-subject' };
const createMethods = () => ({
  resolvePrincipal: jest.fn().mockResolvedValue(principal),
  findUserBySourceId: jest.fn().mockResolvedValue(null),
  findUserByEmail: jest.fn().mockResolvedValue(null),
  createUser: jest.fn().mockResolvedValue('created-user'),
});

describe('ensureDirectoryPrincipalUser', () => {
  it('resolves a trusted identity before returning a directory-linked user', async () => {
    const methods = createMethods();
    methods.findUserBySourceId.mockResolvedValue({ id: 'source-user' });

    await expect(ensureDirectoryPrincipalUser(principal, methods)).resolves.toBe('source-user');
    expect(methods.resolvePrincipal).toHaveBeenCalledWith(principal);
    expect(methods.findUserByEmail).not.toHaveBeenCalled();
    expect(methods.createUser).not.toHaveBeenCalled();
  });

  it('returns an existing user by canonical email without linking its identity', async () => {
    const methods = createMethods();
    methods.findUserByEmail.mockResolvedValue({ id: 'email-user' });

    await expect(ensureDirectoryPrincipalUser(principal, methods)).resolves.toBe('email-user');
    expect(methods.findUserByEmail).toHaveBeenCalledWith('directory-user@example.com');
    expect(methods.createUser).not.toHaveBeenCalled();
  });

  it('ignores submitted identity metadata when creating a directory placeholder', async () => {
    const methods = createMethods();
    const forged = { ...principal, name: 'Forged', email: 'victim@example.com' };

    await expect(ensureDirectoryPrincipalUser(forged, methods)).resolves.toBe('created-user');
    expect(methods.findUserByEmail).toHaveBeenCalledWith('directory-user@example.com');
    expect(methods.createUser).toHaveBeenCalledWith({
      name: principal.name,
      email: 'directory-user@example.com',
      emailVerified: false,
      provider: 'openid',
      idOnTheSource: principal.idOnTheSource,
    });
  });

  it.each([null, { ...principal, email: undefined }, { ...principal, type: PrincipalType.GROUP }])(
    'rejects unresolved or incomplete identities before database access: %j',
    async (resolved) => {
      const methods = createMethods();
      methods.resolvePrincipal.mockResolvedValue(resolved);

      await expect(ensureDirectoryPrincipalUser(principal, methods)).rejects.toThrow(
        'Directory user principal is unavailable',
      );
      expect(methods.findUserBySourceId).not.toHaveBeenCalled();
      expect(methods.findUserByEmail).not.toHaveBeenCalled();
      expect(methods.createUser).not.toHaveBeenCalled();
    },
  );

  it('propagates provider failures without touching the database', async () => {
    const methods = createMethods();
    methods.resolvePrincipal.mockRejectedValue(new Error('Provider unavailable'));
    await expect(ensureDirectoryPrincipalUser(principal, methods)).rejects.toThrow(
      'Provider unavailable',
    );
    expect(methods.findUserBySourceId).not.toHaveBeenCalled();
    expect(methods.findUserByEmail).not.toHaveBeenCalled();
    expect(methods.createUser).not.toHaveBeenCalled();
  });
});

describe('resolveDirectoryPrincipal', () => {
  const createClient = () => {
    const get = jest.fn().mockResolvedValue({
      id: principal.idOnTheSource,
      displayName: principal.name,
      mail: principal.email,
    });
    const select = jest.fn(() => ({ get }));
    const api = jest.fn(() => ({ select }));
    return { get, api, create: jest.fn().mockResolvedValue({ api }) };
  };

  it.each([null, { ...authContext, accessToken: '' }, { ...authContext, sub: '' }])(
    'does not call Graph without authenticated integration context: %j',
    async (context) => {
      const client = createClient();
      await expect(
        resolveDirectoryPrincipal(principal, context, client.create),
      ).resolves.toBeNull();
      expect(client.create).not.toHaveBeenCalled();
    },
  );

  it('takes user metadata only from Graph', async () => {
    const client = createClient();
    const resolved = await resolveDirectoryPrincipal(
      { ...principal, idOnTheSource: 'directory-user-id' },
      authContext,
      client.create,
    );
    expect(client.create).toHaveBeenCalledWith(authContext.accessToken, authContext.sub);
    expect(client.api).toHaveBeenCalledWith('/users/directory-user-id');
    expect(resolved).toEqual({
      ...principal,
      email: principal.email.toLowerCase(),
      source: 'entra',
    });
  });

  it('supports organizational People results when directory user lookup is forbidden', async () => {
    const client = createClient();
    client.get.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
    client.get.mockResolvedValueOnce({
      id: principal.idOnTheSource,
      displayName: principal.name,
      personType: { class: 'Person', subclass: 'OrganizationUser' },
      scoredEmailAddresses: [{ address: principal.email }],
    });
    await expect(
      resolveDirectoryPrincipal(principal, authContext, client.create),
    ).resolves.toMatchObject({ email: principal.email.toLowerCase() });
    expect(client.api).toHaveBeenLastCalledWith('/me/people/directory-user-id');
  });

  it.each([
    [403, 403],
    [403, 404],
    [404, 403],
  ])('propagates authorization failure when users=%s and People=%s', async (users, people) => {
    const client = createClient();
    client.get.mockRejectedValueOnce(
      Object.assign(new Error('Denied users'), { statusCode: users }),
    );
    client.get.mockRejectedValueOnce(
      Object.assign(new Error('Denied People'), { statusCode: people }),
    );
    await expect(
      resolveDirectoryPrincipal(principal, authContext, client.create),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('propagates group authorization failure without a People fallback', async () => {
    const client = createClient();
    client.get.mockRejectedValue(Object.assign(new Error('Denied'), { statusCode: 403 }));
    await expect(
      resolveDirectoryPrincipal(
        { ...principal, type: PrincipalType.GROUP },
        authContext,
        client.create,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('rejects personal contacts instead of provisioning them as directory users', async () => {
    const client = createClient();
    client.get.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: principal.idOnTheSource,
      displayName: principal.name,
      personType: { subclass: 'PersonalContact' },
      scoredEmailAddresses: [{ address: principal.email }],
    });
    await expect(
      resolveDirectoryPrincipal(principal, authContext, client.create),
    ).resolves.toBeNull();
  });

  it('returns absence for inaccessible identities', async () => {
    const client = createClient();
    client.get.mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404 }));
    await expect(
      resolveDirectoryPrincipal(principal, authContext, client.create),
    ).resolves.toBeNull();
  });

  it('does not convert provider outages to absence or fall back', async () => {
    const client = createClient();
    client.get.mockRejectedValue(Object.assign(new Error('Unavailable'), { statusCode: 503 }));
    await expect(resolveDirectoryPrincipal(principal, authContext, client.create)).rejects.toThrow(
      'Unavailable',
    );
    expect(client.api).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: 'different-id', displayName: 'Wrong User', mail: 'wrong@example.com' },
    { id: principal.idOnTheSource, displayName: 'Missing Email' },
  ])('rejects mismatched or incomplete Graph records: %j', async (record) => {
    const client = createClient();
    client.get.mockResolvedValue(record);
    await expect(
      resolveDirectoryPrincipal(principal, authContext, client.create),
    ).resolves.toBeNull();
  });

  it('resolves group metadata independently of submitted name, email, and description', async () => {
    const client = createClient();
    client.get.mockResolvedValue({
      id: 'group-id',
      displayName: 'Trusted Group',
      description: 'Trusted description',
    });
    await expect(
      resolveDirectoryPrincipal(
        { type: PrincipalType.GROUP, idOnTheSource: 'group-id' },
        authContext,
        client.create,
      ),
    ).resolves.toEqual({
      type: PrincipalType.GROUP,
      source: 'entra',
      idOnTheSource: 'group-id',
      name: 'Trusted Group',
      description: 'Trusted description',
    });
    expect(client.api).toHaveBeenCalledWith('/groups/group-id');
  });

  it('encodes source IDs as a single path component', async () => {
    const client = createClient();
    await resolveDirectoryPrincipal(
      { ...principal, idOnTheSource: 'id/other?$select=mail' },
      authContext,
      client.create,
    );
    expect(client.api).toHaveBeenCalledWith('/users/id%2Fother%3F%24select%3Dmail');
  });
});

describe('validateLocalPrincipalId', () => {
  it('accepts an existing local principal ID', () => {
    expect(validateLocalPrincipalId('507f1f77bcf86cd799439011')).toBe('507f1f77bcf86cd799439011');
  });
  it.each([null, undefined, '', 'invalid', { $ne: null }, ['507f1f77bcf86cd799439011']])(
    'rejects malformed IDs before database lookup: %j',
    (id) => expect(() => validateLocalPrincipalId(id)).toThrow('Invalid local principal ID'),
  );
});

describe('preparePermissionPrincipals', () => {
  const createDeps = () => ({
    createClient: jest.fn(),
    retryOptions: [],
    findPermissionUser: jest.fn().mockResolvedValue(null),
    findPermissionGroup: jest.fn().mockResolvedValue(null),
    persistPermissionPrincipals: jest
      .fn()
      .mockImplementation(async (changes) => changes.map(() => 'user-id')),
    includeOwners: false,
    logger: { error: jest.fn() },
  });
  const external = (id: string) => ({ ...principal, source: 'entra' as const, idOnTheSource: id });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('bounds parallel lookups, reuses one client, and verifies all identities before persistence', async () => {
    const deps = createDeps();
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const get = jest.fn(
      (id: string) =>
        new Promise((resolve) => {
          active++;
          peak = Math.max(peak, active);
          releases.push(() => {
            active--;
            resolve({ id, displayName: 'Trusted', mail: `${id}@example.com` });
          });
        }),
    );
    deps.createClient.mockResolvedValue({
      api: (path: string) => graphRequest(() => ({ get: () => get(path.split('/').pop()!) })),
    });
    const principals = ['a', 'b', 'c', 'd'].map(external);
    const work = preparePermissionPrincipals(principals, authContext, deps, {
      concurrency: { permissionPrincipalLookups: 2 },
    });
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(deps.persistPermissionPrincipals).not.toHaveBeenCalled();
    releases
      .splice(0)
      .reverse()
      .forEach((release) => release());
    await flush();
    expect(get).toHaveBeenCalledTimes(4);
    expect(deps.persistPermissionPrincipals).not.toHaveBeenCalled();
    releases
      .splice(0)
      .reverse()
      .forEach((release) => release());
    await expect(work).resolves.toEqual(principals.map((p) => ({ ...p, id: 'user-id' })));
    expect(peak).toBe(2);
    expect(deps.createClient).toHaveBeenCalledTimes(1);
    expect(deps.persistPermissionPrincipals).toHaveBeenCalledTimes(1);
  });

  it('deduplicates reads and persistence for repeated external identities', async () => {
    const deps = createDeps();
    const get = jest
      .fn()
      .mockResolvedValue({ id: 'a', displayName: 'Trusted', mail: 'a@example.com' });
    deps.createClient.mockResolvedValue({ api: () => graphRequest(() => ({ get })) });
    await preparePermissionPrincipals([external('a'), external('a')], authContext, deps);
    expect(get).toHaveBeenCalledTimes(1);
    expect(deps.persistPermissionPrincipals.mock.calls[0][0]).toHaveLength(1);
  });

  it.each(['client', 'lookup'])(
    'fails before persistence when %s verification fails',
    async (failure) => {
      const deps = createDeps();
      const error = new Error('Sensitive provider detail');
      if (failure === 'client') deps.createClient.mockRejectedValue(error);
      else
        deps.createClient.mockResolvedValue({
          api: () =>
            graphRequest(() => ({
              get: async () => {
                throw error;
              },
            })),
        });
      await expect(
        preparePermissionPrincipals([external('a')], authContext, deps),
      ).rejects.toMatchObject({ statusCode: 502, code: 'DIRECTORY_VERIFICATION_UNAVAILABLE' });
      expect(deps.persistPermissionPrincipals).not.toHaveBeenCalled();
    },
  );

  it.each(['findPermissionUser', 'findPermissionGroup'] as const)(
    'does not persist when %s fails after another principal is staged',
    async (method) => {
      const deps = createDeps();
      deps[method].mockRejectedValue(new Error('Private database diagnostics'));
      await expect(
        preparePermissionPrincipals(
          [
            {
              ...principal,
              type: method === 'findPermissionUser' ? PrincipalType.USER : PrincipalType.GROUP,
              id: '507f1f77bcf86cd799439011',
            },
          ],
          null,
          deps,
        ),
      ).rejects.toMatchObject({ statusCode: 500, code: 'PRINCIPAL_PREPARATION_FAILED' });
      expect(deps.persistPermissionPrincipals).not.toHaveBeenCalled();
    },
  );

  it('omits confirmed absent principals without writes', async () => {
    const deps = createDeps();
    await expect(
      preparePermissionPrincipals([{ ...principal, id: '507f1f77bcf86cd799439011' }], null, deps),
    ).resolves.toEqual([]);
    expect(deps.persistPermissionPrincipals).toHaveBeenCalledWith([]);
  });

  it.each([1, 2])(
    'bounds members, owners and pagination to %i actual Graph requests',
    async (concurrency) => {
      const deps = createDeps();
      deps.includeOwners = true;
      deps.findPermissionGroup.mockImplementation(async ({ id }) => ({
        id,
        source: 'entra',
        idOnTheSource: id,
      }));
      let active = 0;
      let peak = 0;
      const paths: string[] = [];
      const get = async (path: string) => {
        paths.push(path);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return {
          value: [],
          ...(!path.includes('?') && {
            '@odata.nextLink': `https://graph.microsoft.com/v1.0${path}?page=2`,
          }),
        };
      };
      deps.createClient.mockResolvedValue({
        api: (path: string) => graphRequest(() => ({ top: () => ({ get: () => get(path) }) })),
      });
      await preparePermissionPrincipals(
        ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'].map((id) => ({
          type: PrincipalType.GROUP,
          id,
        })),
        authContext,
        deps,
        { concurrency: { permissionPrincipalLookups: concurrency } },
      );
      expect(peak).toBe(concurrency);
      expect(paths).toHaveLength(8);
      expect(deps.createClient).toHaveBeenCalledTimes(1);
    },
  );
});

describe('directory preparation deadline', () => {
  const auth = authContext;
  const identities = ['a', 'b', 'c'].map((idOnTheSource) => ({
    ...principal,
    source: 'entra' as const,
    idOnTheSource,
  }));
  const config = { concurrency: { permissionPrincipalLookups: 1 }, timeouts: { directoryMs: 20 } };
  const createDeps = () => ({
    createClient: jest.fn(),
    retryOptions: [],
    includeOwners: true,
    findPermissionUser: jest.fn().mockResolvedValue(null),
    findPermissionGroup: jest.fn().mockResolvedValue(null),
    persistPermissionPrincipals: jest.fn().mockResolvedValue([]),
    logger: { error: jest.fn() },
  });
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('bounds client creation and never starts Graph or persistence after late resolution', async () => {
    const deps = createDeps();
    let complete: (value: object) => void = () => undefined;
    deps.createClient.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const work = preparePermissionPrincipals(identities, auth, deps, config);
    const rejected = work.catch((error) => error);
    await jest.advanceTimersByTimeAsync(20);
    expect(await rejected).toMatchObject({
      statusCode: 502,
      code: 'DIRECTORY_VERIFICATION_UNAVAILABLE',
    });
    const signal: AbortSignal = deps.createClient.mock.calls[0][2];
    expect(signal.aborted).toBe(true);
    const api = jest.fn();
    complete({ api });
    await jest.advanceTimersByTimeAsync(0);
    expect(api).not.toHaveBeenCalled();
    expect(deps.persistPermissionPrincipals).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['identity', 'members', 'owners', 'later page'])(
    'aborts a stalled %s read, cancels queued calls, and cannot persist late results',
    async (phase) => {
      const deps = createDeps();
      const requests: string[] = [];
      let complete: (value: object) => void = () => undefined;
      let transportSignal: AbortSignal | undefined;
      const query = (path: string) => {
        const get = async () => {
          requests.push(path);
          if (phase === 'members' || phase === 'owners' || phase === 'later page') {
            if (phase === 'later page' && !path.includes('?'))
              return {
                value: [],
                '@odata.nextLink': `https://graph.microsoft.com/v1.0${path}?page=2`,
              };
            if (phase === 'owners' && path.includes('transitiveMembers')) return { value: [] };
          }
          return new Promise((resolve) => {
            complete = resolve;
          });
        };
        const request = graphRequest(() => ({ get, top: () => ({ get }) }));
        request.options = ({ signal }) => {
          transportSignal = signal;
          return request;
        };
        return request;
      };
      deps.createClient.mockResolvedValue({ api: query });
      deps.findPermissionGroup.mockResolvedValue({
        id: '507f1f77bcf86cd799439011',
        source: 'entra',
        idOnTheSource: 'group-id',
      });
      const recipients =
        phase === 'identity'
          ? identities
          : [{ type: PrincipalType.GROUP, id: '507f1f77bcf86cd799439011' }];
      const work = preparePermissionPrincipals(recipients, auth, deps, config);
      const rejected = work.catch((error) => error);
      await jest.advanceTimersByTimeAsync(20);
      expect(await rejected).toMatchObject({
        statusCode: 502,
        code: 'DIRECTORY_VERIFICATION_UNAVAILABLE',
      });
      expect(transportSignal?.aborted).toBe(true);
      const count = requests.length;
      complete({
        id: 'a',
        displayName: 'Trusted',
        mail: 'a@example.com',
        value: [],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/group-id/owners?page=3',
      });
      await jest.advanceTimersByTimeAsync(100);
      expect(requests).toHaveLength(count);
      expect(deps.persistPermissionPrincipals).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('clears the deadline after successful reads without timing out persistence', async () => {
    const deps = createDeps();
    deps.createClient.mockResolvedValue({
      api: () =>
        graphRequest(() => ({
          get: async () => ({ id: 'a', displayName: 'Trusted', mail: 'a@example.com' }),
        })),
    });
    deps.persistPermissionPrincipals.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return ['created'];
    });
    const work = preparePermissionPrincipals([identities[0]], auth, deps, config);
    await jest.advanceTimersByTimeAsync(60);
    await expect(work).resolves.toMatchObject([{ id: 'created' }]);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('refreshDirectoryGroupMembers', () => {
  const group = { source: 'entra' as const, idOnTheSource: 'stored-group-id' };
  const createMethods = () => {
    const getGroupMembers = jest.fn().mockResolvedValue({
      value: [{ id: 'active-member', '@odata.type': '#microsoft.graph.user' }],
    });
    const getGroupOwners = jest
      .fn()
      .mockResolvedValue({ value: [{ id: 'active-member' }, { id: 'owner' }] });
    const api = jest.fn((path: string) => ({
      select: () => ({
        top: () => ({
          get: () => (path.includes('/owners') ? getGroupOwners() : getGroupMembers()),
        }),
      }),
    }));
    return {
      getGroupMembers,
      getGroupOwners,
      api,
      createClient: jest.fn().mockResolvedValue({ api }),
      includeOwners: false,
      updateMembers: jest.fn().mockResolvedValue(undefined),
      logger: { error: jest.fn() },
    };
  };

  it('refreshes members by stored external ID and includes owners only when configured', async () => {
    const methods = createMethods();
    methods.includeOwners = true;
    await refreshDirectoryGroupMembers(group, authContext, methods);
    expect(methods.createClient).toHaveBeenCalledWith(authContext.accessToken, authContext.sub);
    expect(methods.api).toHaveBeenCalledWith('/groups/stored-group-id/transitiveMembers');
    expect(methods.api).toHaveBeenCalledWith('/groups/stored-group-id/owners');
    expect(methods.updateMembers).toHaveBeenCalledWith(['active-member', 'owner']);
  });

  it('replaces stale members with an empty successful directory response', async () => {
    const methods = createMethods();
    methods.getGroupMembers.mockResolvedValue({ value: [] });
    await refreshDirectoryGroupMembers(group, authContext, methods);
    expect(methods.updateMembers).toHaveBeenCalledWith([]);
    expect(methods.getGroupOwners).not.toHaveBeenCalled();
  });

  it.each([null, { ...authContext, accessToken: '' }, { ...authContext, sub: '' }])(
    'preserves persisted members without authenticated integration context: %j',
    async (context) => {
      const methods = createMethods();
      await refreshDirectoryGroupMembers(group, context, methods);
      expect(methods.getGroupMembers).not.toHaveBeenCalled();
      expect(methods.updateMembers).not.toHaveBeenCalled();
    },
  );

  it('does not use directory fields on a local group', async () => {
    const methods = createMethods();
    await refreshDirectoryGroupMembers({ ...group, source: 'local' }, authContext, methods);
    expect(methods.getGroupMembers).not.toHaveBeenCalled();
    expect(methods.updateMembers).not.toHaveBeenCalled();
  });

  it('does not overwrite persisted membership on a rejected provider call', async () => {
    const methods = createMethods();
    methods.getGroupMembers.mockRejectedValue(new Error('Sensitive provider detail'));
    await expect(refreshDirectoryGroupMembers(group, authContext, methods)).rejects.toBeInstanceOf(
      DirectoryVerificationError,
    );
    expect(methods.updateMembers).not.toHaveBeenCalled();
  });
});

describe('strict directory membership snapshots', () => {
  const group = { source: 'entra' as const, idOnTheSource: 'group-id' };
  const createMethods = () => {
    const get = jest.fn().mockResolvedValue({ value: [] });
    const api = jest.fn(() => ({ select: () => ({ top: () => ({ get }) }) }));
    return {
      get,
      api,
      createClient: jest.fn().mockResolvedValue({ api }),
      includeOwners: false,
      updateMembers: jest.fn().mockResolvedValue(undefined),
      logger: { error: jest.fn() },
    };
  };

  it.each(['client', 'members', 'owners', 'later page'])(
    'preserves persisted membership on a rejected %s lookup',
    async (failure) => {
      const methods = createMethods();
      const error = new Error('Private Graph failure');
      if (failure === 'client') {
        methods.createClient.mockRejectedValue(error);
      } else if (failure === 'later page') {
        methods.get.mockResolvedValueOnce({
          value: [{ id: 'first-member', '@odata.type': '#microsoft.graph.user' }],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/groups/group-id/transitiveMembers?$skiptoken=next',
        });
        methods.get.mockRejectedValueOnce(error);
      } else if (failure === 'owners') {
        methods.includeOwners = true;
        methods.get.mockResolvedValueOnce({
          value: [{ id: 'member', '@odata.type': '#microsoft.graph.user' }],
        });
        methods.get.mockRejectedValueOnce(error);
      } else {
        methods.get.mockRejectedValue(error);
      }
      await expect(refreshDirectoryGroupMembers(group, authContext, methods)).rejects.toMatchObject(
        { statusCode: 502, message: 'Directory identity verification failed' },
      );
      expect(methods.updateMembers).not.toHaveBeenCalled();
    },
  );

  it('combines all successful pages and excludes non-user members', async () => {
    const methods = createMethods();
    methods.get.mockResolvedValueOnce({
      value: [
        { id: 'member-1', '@odata.type': '#microsoft.graph.user' },
        { id: 'child', '@odata.type': '#microsoft.graph.group' },
      ],
      '@odata.nextLink':
        'https://graph.microsoft.com/v1.0/groups/group-id/transitiveMembers?$skiptoken=next',
    });
    methods.get.mockResolvedValueOnce({
      value: [{ id: 'member-2', '@odata.type': '#microsoft.graph.user' }],
    });
    await refreshDirectoryGroupMembers(group, authContext, methods);
    expect(methods.updateMembers).toHaveBeenCalledWith(['member-1', 'member-2']);
    expect(methods.api).toHaveBeenLastCalledWith(
      '/groups/group-id/transitiveMembers?$skiptoken=next',
    );
  });

  it('propagates storage failures without misclassifying them as directory failures', async () => {
    const methods = createMethods();
    const error = new Error('Private database failure');
    methods.updateMembers.mockRejectedValue(error);
    await expect(refreshDirectoryGroupMembers(group, authContext, methods)).rejects.toBe(error);
  });
});

describe('principal failure codes', () => {
  it.each([
    [new PrincipalPreparationError(), 'PRINCIPAL_PREPARATION_FAILED'],
    [new DirectoryVerificationError(), 'DIRECTORY_VERIFICATION_UNAVAILABLE'],
  ])('approves the stable error code for %p', (error, code) => {
    expect(permissionErrorCode(error)).toEqual({ code });
  });
});

describe('real Graph SDK verification adapter', () => {
  afterEach(() => jest.restoreAllMocks());
  it('passes the abort signal to fetch and disables uncancellable SDK backoff', async () => {
    let signal: AbortSignal | undefined;
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (_url, options) => {
      signal = options?.signal ?? undefined;
      return new Response(
        JSON.stringify({ error: { code: 'Unavailable', message: 'Private provider message' } }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '120' },
        },
      );
    });
    const deps = {
      createClient: async () =>
        Client.init({ authProvider: (done) => done(null, 'test-graph-token') }),
      retryOptions: [new RetryHandlerOptions(0, 0)],
      includeOwners: false,
      findPermissionUser: jest.fn(),
      findPermissionGroup: jest.fn(),
      persistPermissionPrincipals: jest.fn(),
      logger: { error: jest.fn() },
    };
    await expect(
      preparePermissionPrincipals([{ ...principal, source: 'entra' }], authContext, deps, {
        timeouts: { directoryMs: 1000 },
      }),
    ).rejects.toMatchObject({ code: 'DIRECTORY_VERIFICATION_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(deps.persistPermissionPrincipals).not.toHaveBeenCalled();
  });
});
