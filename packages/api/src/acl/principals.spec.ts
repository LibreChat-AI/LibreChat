import { PrincipalType } from 'librechat-data-provider';
import {
  ensureDirectoryPrincipalUser,
  resolveDirectoryPrincipal,
  validateLocalPrincipalId,
} from './principals';

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
