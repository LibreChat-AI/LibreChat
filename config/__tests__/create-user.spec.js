const { AsyncLocalStorage } = require('async_hooks');

const mockTenantStorage = new AsyncLocalStorage();
const mockUsers = [];
const mockSilentExit = jest.fn();
const mockAskQuestion = jest.fn();
const mockRegisterUser = jest.fn();

const matches = (user, filter) =>
  filter.$or.some((clause) => Object.entries(clause).every(([key, value]) => user[key] === value));

jest.mock('../connect', () => jest.fn(async () => undefined));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  tenantStorage: mockTenantStorage,
  createModels: () => ({
    User: {
      findOne: jest.fn(async (filter) => {
        const tenantId = mockTenantStorage.getStore()?.tenantId;
        return (
          mockUsers.find((user) => user.tenantId === tenantId && matches(user, filter)) ?? null
        );
      }),
    },
  }),
}));
jest.mock('~/server/services/AuthService', () => ({
  registerUser: (...args) => mockRegisterUser(...args),
}));
jest.mock('../helpers', () => ({
  ...jest.requireActual('../helpers'),
  askQuestion: mockAskQuestion,
  silentExit: mockSilentExit,
}));

/** Registrations made before the CLI exited; the mocked exit does not stop the script. */
let registrationsAtExit;

const runCli = (args) =>
  new Promise((resolve, reject) => {
    mockSilentExit.mockImplementation((code = 0) => {
      registrationsAtExit ??= mockRegisterUser.mock.calls.length;
      resolve(code);
    });
    process.argv = ['node', 'create-user.js', ...args];
    jest.isolateModules(() => {
      try {
        require('../create-user');
      } catch (error) {
        reject(error);
      }
    });
  });

describe('create-user CLI', () => {
  const argv = process.argv;
  const args = ['bot@example.com', 'Bot', 'bot', 'a-long-enough-password', '--email-verified=true'];

  beforeEach(() => {
    mockUsers.length = 0;
    registrationsAtExit = undefined;
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockRegisterUser.mockImplementation(async ({ email, name, username }) => {
      const tenantId = mockTenantStorage.getStore()?.tenantId;
      mockUsers.push({ _id: 'u1', email, name, username, tenantId, emailVerified: true });
      return { status: 200, userCreated: true };
    });
  });

  afterEach(() => {
    process.argv = argv;
    jest.restoreAllMocks();
  });

  it('creates the user in the named tenant and reports its id', async () => {
    await expect(runCli([...args, '--tenant=acme'])).resolves.toBe(0);

    expect(mockRegisterUser).toHaveBeenCalledTimes(1);
    expect(mockUsers).toEqual([expect.objectContaining({ email: args[0], tenantId: 'acme' })]);
    expect(console.log).toHaveBeenCalledWith(expect.any(String), 'User ID: u1');
    expect(console.log).toHaveBeenCalledWith(expect.any(String), 'Tenant: acme');
  });

  it('creates the user without a tenant when none is named', async () => {
    await expect(runCli(args)).resolves.toBe(0);

    expect(mockUsers).toEqual([expect.objectContaining({ email: args[0], tenantId: undefined })]);
  });

  it('checks for an existing user within the named tenant only', async () => {
    mockUsers.push({ _id: 'u0', email: args[0], username: 'bot', tenantId: 'other' });

    await expect(runCli([...args, '--tenant=acme'])).resolves.toBe(0);

    expect(mockRegisterUser).toHaveBeenCalledTimes(1);
  });

  it.each(['', '__SYSTEM__', 'bad/tenant', 'x'.repeat(129)])(
    'rejects the tenant ID %p before touching the database',
    async (tenantId) => {
      await expect(runCli([...args, `--tenant=${tenantId}`])).resolves.toBe(1);

      expect(registrationsAtExit).toBe(0);
    },
  );
});
