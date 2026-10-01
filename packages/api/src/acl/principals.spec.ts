import { ensureDirectoryPrincipalUser } from './principals';

const createMethods = () => ({
  findUserBySourceId: jest.fn().mockResolvedValue(null),
  findUserByEmail: jest.fn().mockResolvedValue(null),
  createUser: jest.fn().mockResolvedValue('created-user'),
});

const principal = {
  name: 'Directory User',
  email: 'Directory-User@Example.com',
  idOnTheSource: 'directory-user-id',
};

describe('ensureDirectoryPrincipalUser', () => {
  it('returns a user already linked to the directory source ID without an email lookup', async () => {
    const methods = createMethods();
    methods.findUserBySourceId.mockResolvedValue({ id: 'source-user' });

    await expect(ensureDirectoryPrincipalUser(principal, methods)).resolves.toBe('source-user');
    expect(methods.findUserByEmail).not.toHaveBeenCalled();
    expect(methods.createUser).not.toHaveBeenCalled();
  });

  it('returns an existing user found by email without creating a placeholder', async () => {
    const methods = createMethods();
    methods.findUserByEmail.mockResolvedValue({ id: 'email-user' });

    await expect(ensureDirectoryPrincipalUser(principal, methods)).resolves.toBe('email-user');
    expect(methods.createUser).not.toHaveBeenCalled();
  });

  it('creates a normalized directory placeholder when neither identifier matches', async () => {
    const methods = createMethods();

    await expect(ensureDirectoryPrincipalUser(principal, methods)).resolves.toBe('created-user');
    expect(methods.createUser).toHaveBeenCalledWith({
      name: principal.name,
      email: 'directory-user@example.com',
      emailVerified: false,
      provider: 'openid',
      idOnTheSource: principal.idOnTheSource,
    });
  });

  it('rejects incomplete directory principals before database access', async () => {
    const methods = createMethods();

    await expect(ensureDirectoryPrincipalUser({ name: 'Incomplete' }, methods)).rejects.toThrow(
      'Directory user principals must have email and idOnTheSource',
    );
    expect(methods.findUserBySourceId).not.toHaveBeenCalled();
  });
});
