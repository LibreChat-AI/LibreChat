const mockCalls = [];
const mockUserId = 'user-1';
const mockFailures = new Set();
const mockStep = (name, value) =>
  jest.fn(async () => {
    mockCalls.push(name);
    if (mockFailures.has(name)) {
      throw new Error(`${name} failed`);
    }
    return value;
  });

const mockStampedAt = new Date('2026-01-01T00:00:00.000Z');
const mockMethods = {
  updateUser: jest.fn(async (_id, update) => {
    const name = update.password ? 'writePassword' : 'restamp';
    mockCalls.push(name);
    if (mockFailures.has(name)) {
      throw new Error(`${name} failed`);
    }
    return { _id: mockUserId };
  }),
  awaitAuthUserDocEviction: mockStep('evict'),
};

jest.mock('../connect', () => jest.fn(async () => undefined));
jest.mock('../helpers', () => ({
  askSilentQuestion: jest.fn(async () => 'a-new-password'),
}));
jest.mock('~/cache/getLogStores', () => jest.fn());
jest.mock('readline', () => ({
  createInterface: () => ({
    question: (_query, answer) => answer('user@example.com'),
    close: () => undefined,
  }),
}));
jest.mock('@librechat/api', () => ({
  createPasswordResetUpdate: (password) => ({ password, credentialsChangedAt: mockStampedAt }),
  restampRetirementCutoff: (field, _userId, stampedAt, write) =>
    write({ [field]: new Date() }, { [field]: stampedAt }),
}));
jest.mock('@librechat/data-schemas', () => ({
  createModels: () => ({
    User: { findOne: async () => ({ _id: mockUserId }) },
    Passkey: { deleteMany: mockStep('deletePasskeys', { deletedCount: 1 }) },
    Session: { deleteMany: mockStep('deleteSessions') },
  }),
  createMethods: () => mockMethods,
}));

/** The script runs on load and ends in process.exit, so the exit code is its result. */
const runScript = () =>
  new Promise((resolve) => {
    jest.spyOn(process, 'exit').mockImplementation((code) => {
      resolve(code);
      /** Ends the script's flow the way a real exit would, without tripping its own catch. */
      return new Promise(() => undefined);
    });
    jest.isolateModules(() => require('../reset-password'));
  });

describe('Reset password CLI', () => {
  beforeEach(() => {
    mockCalls.length = 0;
    mockFailures.clear();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('settles the auth cache after the final cutoff write', async () => {
    await expect(runScript()).resolves.toBe(0);

    expect(mockCalls).toEqual([
      'writePassword',
      'deletePasskeys',
      'deleteSessions',
      'restamp',
      'evict',
    ]);
  });

  it.each(['deletePasskeys', 'deleteSessions', 'restamp', 'evict'])(
    'runs every other step and exits non-zero when %s fails',
    async (failing) => {
      mockFailures.add(failing);

      await expect(runScript()).resolves.toBe(1);

      expect(mockCalls).toEqual([
        'writePassword',
        'deletePasskeys',
        'deleteSessions',
        'restamp',
        'evict',
      ]);
    },
  );
});
