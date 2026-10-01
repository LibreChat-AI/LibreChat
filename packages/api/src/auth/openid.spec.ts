import mongoose, { Types } from 'mongoose';
import { ErrorTypes } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger, createMethods, createModels } from '@librechat/data-schemas';
import type { IUser, UserMethods } from '@librechat/data-schemas';
import type { CommandStartedEvent } from 'mongodb';
import type { FilterQuery } from 'mongoose';
import { findOpenIDUser, getOpenIdEmail, getOpenIdIssuer, normalizeOpenIdIssuer } from './openid';
import { recordOpenIDUserLookup } from '~/app/metrics';

function newId() {
  return new Types.ObjectId();
}

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('~/app/metrics', () => ({
  isMetricsConfigured: jest.fn(() => true),
  recordOpenIDUserLookup: jest.fn(),
}));

describe('normalizeOpenIdIssuer', () => {
  it('normalizes blank, trailing-slash, and discovery-document issuers', () => {
    expect(normalizeOpenIdIssuer('')).toBeUndefined();
    expect(normalizeOpenIdIssuer('   ')).toBeUndefined();
    expect(normalizeOpenIdIssuer('https://issuer.example.com/')).toBe('https://issuer.example.com');
    expect(
      normalizeOpenIdIssuer('https://issuer.example.com/.well-known/openid-configuration/'),
    ).toBe('https://issuer.example.com');
    expect(
      normalizeOpenIdIssuer('https://issuer.example.com/realm/.well-known/openid-configuration'),
    ).toBe('https://issuer.example.com/realm');
  });
});

describe('getOpenIdIssuer', () => {
  const originalOpenIdIssuer = process.env.OPENID_ISSUER;

  afterEach(() => {
    if (originalOpenIdIssuer == null) {
      delete process.env.OPENID_ISSUER;
      return;
    }

    process.env.OPENID_ISSUER = originalOpenIdIssuer;
  });

  it('prefers token issuer and falls back to metadata and env issuer', () => {
    process.env.OPENID_ISSUER = 'https://env.example.com/.well-known/openid-configuration';

    expect(
      getOpenIdIssuer(
        { iss: 'https://token.example.com/' },
        { serverMetadata: () => ({ issuer: 'https://metadata.example.com' }) },
      ),
    ).toBe('https://token.example.com');
    expect(
      getOpenIdIssuer({}, { serverMetadata: () => ({ issuer: 'https://metadata.example.com/' }) }),
    ).toBe('https://metadata.example.com');
    expect(getOpenIdIssuer({})).toBe('https://env.example.com');
  });
});

describe('findOpenIDUser', () => {
  let mockFindUser: jest.MockedFunction<UserMethods['findUser']>;
  const originalOpenIdIssuer = process.env.OPENID_ISSUER;
  const issuer = 'https://issuer.example.com';

  beforeEach(() => {
    mockFindUser = jest.fn();
    delete process.env.OPENID_ISSUER;
    jest.clearAllMocks();
    (logger.warn as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
  });

  afterAll(() => {
    if (originalOpenIdIssuer == null) {
      delete process.env.OPENID_ISSUER;
      return;
    }
    process.env.OPENID_ISSUER = originalOpenIdIssuer;
  });

  describe('Primary condition searches', () => {
    it('should find user by openidId', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        openidIssuer: issuer,
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(mockFindUser).toHaveBeenCalledWith({
        openidId: 'openid_123',
        openidIssuer: issuer,
      });
      expect(result).toEqual({
        user: mockUser,
        error: null,
        migration: false,
      });
      expect(recordOpenIDUserLookup).toHaveBeenCalledWith('found', expect.any(Number));
    });

    it('should find user by idOnTheSource', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        idOnTheSource: 'source_123',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        idOnTheSource: 'source_123',
      });

      expect(mockFindUser).toHaveBeenNthCalledWith(1, {
        openidId: 'openid_123',
        openidIssuer: issuer,
      });
      expect(mockFindUser).toHaveBeenNthCalledWith(2, {
        idOnTheSource: 'source_123',
        openidIssuer: issuer,
      });
      expect(result).toEqual({
        user: mockUser,
        error: null,
        migration: false,
      });
    });

    it('should find user by both openidId and idOnTheSource', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        idOnTheSource: 'source_123',
        openidIssuer: issuer,
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        idOnTheSource: 'source_123',
        email: 'user@example.com',
      });

      expect(mockFindUser).toHaveBeenCalledTimes(1);
      expect(mockFindUser).toHaveBeenCalledWith({
        openidId: 'openid_123',
        openidIssuer: issuer,
      });
      expect(result).toEqual({
        user: mockUser,
        error: null,
        migration: false,
      });
    });

    it('should bind primary lookup to issuer', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        openidIssuer: 'https://issuer.example.com',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: 'https://issuer.example.com/',
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(mockFindUser).toHaveBeenCalledWith({
        openidId: 'openid_123',
        openidIssuer: 'https://issuer.example.com',
      });
      expect(result).toEqual({
        user: mockUser,
        error: null,
        migration: false,
      });
    });

    it('should allow legacy issuer-less lookup only for the configured OpenID login issuer', async () => {
      process.env.OPENID_ISSUER = 'https://issuer.example.com/';
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: 'https://issuer.example.com',
        findUser: mockFindUser,
      });

      expect(mockFindUser).toHaveBeenNthCalledWith(1, {
        openidId: 'openid_123',
        openidIssuer: 'https://issuer.example.com',
      });
      expect(mockFindUser).toHaveBeenNthCalledWith(2, {
        openidId: 'openid_123',
        openidIssuer: { $exists: false },
      });
      expect(result).toEqual({
        user: { ...mockUser, openidIssuer: 'https://issuer.example.com' },
        error: null,
        migration: true,
      });
    });

    it('should allow legacy issuer-less lookup when login issuer is a discovery document URL', async () => {
      process.env.OPENID_ISSUER = 'https://issuer.example.com/.well-known/openid-configuration';
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: 'https://issuer.example.com',
        findUser: mockFindUser,
      });

      expect(mockFindUser).toHaveBeenNthCalledWith(1, {
        openidId: 'openid_123',
        openidIssuer: 'https://issuer.example.com',
      });
      expect(mockFindUser).toHaveBeenNthCalledWith(2, {
        openidId: 'openid_123',
        openidIssuer: { $exists: false },
      });
      expect(result).toEqual({
        user: { ...mockUser, openidIssuer: 'https://issuer.example.com' },
        error: null,
        migration: true,
      });
    });

    it('should skip primary ID lookup when issuer context is missing', async () => {
      mockFindUser.mockResolvedValueOnce(null);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        idOnTheSource: 'source_123',
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(mockFindUser).toHaveBeenCalledTimes(1);
      expect(mockFindUser).toHaveBeenCalledWith({ email: 'user@example.com' });
      expect(result).toEqual({
        user: null,
        error: null,
        migration: false,
      });
    });
  });

  describe('Email-based searches', () => {
    it('should find user by email when primary conditions fail and openidId matches', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        openidIssuer: issuer,
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(mockFindUser).toHaveBeenNthCalledWith(1, {
        openidId: 'openid_123',
        openidIssuer: issuer,
      });
      expect(mockFindUser).toHaveBeenNthCalledWith(2, {
        email: 'user@example.com',
      });
      expect(result).toEqual({
        user: mockUser,
        error: null,
        migration: false,
      });
    });

    it('should return null user when email is not found', async () => {
      mockFindUser
        .mockResolvedValueOnce(null) // Primary condition fails
        .mockResolvedValueOnce(null); // Email search fails

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(mockFindUser).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        user: null,
        error: null,
        migration: false,
      });
    });

    it('should not search by email if not provided', async () => {
      mockFindUser.mockResolvedValueOnce(null);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
      });

      expect(mockFindUser).toHaveBeenCalledTimes(1);
      expect(mockFindUser).toHaveBeenCalledWith({
        openidId: 'openid_123',
        openidIssuer: issuer,
      });
      expect(result).toEqual({
        user: null,
        error: null,
        migration: false,
      });
    });
  });

  describe('Provider conflict handling', () => {
    it('should return error when user has different provider', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'google',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser
        .mockResolvedValueOnce(null) // Primary condition fails
        .mockResolvedValueOnce(mockUser); // Email search finds user with different provider

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(result).toEqual({
        user: null,
        error: ErrorTypes.AUTH_FAILED,
        migration: false,
      });
    });

    it('should reject email fallback when existing openidId does not match token sub', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_456',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(result).toEqual({
        user: null,
        error: ErrorTypes.AUTH_FAILED,
        migration: false,
      });
    });

    it('should allow email fallback when existing openidId matches token sub', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        openidIssuer: issuer,
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(result).toEqual({
        user: mockUser,
        error: null,
        migration: false,
      });
    });

    it('should reject email fallback when stored openidIssuer does not match token issuer', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        openidIssuer: 'https://issuer-a.example.com',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: 'https://issuer-b.example.com',
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(result).toEqual({
        user: null,
        error: ErrorTypes.AUTH_FAILED,
        migration: false,
      });
    });

    it('should reject legacy email fallback when token issuer is not the configured OpenID login issuer', async () => {
      process.env.OPENID_ISSUER = 'https://issuer-a.example.com';
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: 'https://issuer-b.example.com',
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(result).toEqual({
        user: null,
        error: ErrorTypes.AUTH_FAILED,
        migration: false,
      });
    });
  });

  describe('User migration scenarios', () => {
    it('should prepare user for migration when email exists without openidId', async () => {
      const mockUser: IUser = {
        _id: newId(),
        email: 'user@example.com',
        username: 'testuser',
        // No provider and no openidId - needs migration
      } as IUser;

      mockFindUser
        .mockResolvedValueOnce(null) // Primary condition fails
        .mockResolvedValueOnce(mockUser); // Email search finds user without openidId

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(result).toEqual({
        user: {
          ...mockUser,
          provider: 'openid',
          openidId: 'openid_123',
          openidIssuer: issuer,
        },
        error: null,
        migration: true,
      });
    });

    it('should persist issuer when migrating a user by email', async () => {
      const mockUser: IUser = {
        _id: newId(),
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: 'https://issuer.example.com',
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(result).toEqual({
        user: {
          ...mockUser,
          provider: 'openid',
          openidId: 'openid_123',
          openidIssuer: 'https://issuer.example.com',
        },
        error: null,
        migration: true,
      });
    });

    it('should reject when user already has a different openidId', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'existing_openid',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(result).toEqual({
        user: null,
        error: ErrorTypes.AUTH_FAILED,
        migration: false,
      });
    });

    it('should reject when user has no provider but a different openidId', async () => {
      const mockUser: IUser = {
        _id: newId(),
        openidId: 'existing_openid',
        email: 'user@example.com',
        username: 'testuser',
        // No provider field — tests a different branch than openid-provider mismatch
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(result).toEqual({
        user: null,
        error: ErrorTypes.AUTH_FAILED,
        migration: false,
      });
    });
  });

  describe('Custom strategy names', () => {
    it('should use custom strategy name in logs', async () => {
      const loggerWarn = logger.warn as jest.Mock;
      loggerWarn.mockClear();

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await findOpenIDUser({
        openidId: 'openid_123',
        findUser: mockFindUser,
        email: 'user@example.com',
        strategyName: 'customStrategy',
      });

      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('[customStrategy]'));
    });

    it('should default to openid strategy name', async () => {
      const loggerWarn = logger.warn as jest.Mock;
      loggerWarn.mockClear();

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await findOpenIDUser({
        openidId: 'openid_123',
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('[openid]'));
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string openidId', async () => {
      mockFindUser.mockResolvedValueOnce(null);

      const result = await findOpenIDUser({
        openidId: '',
        findUser: mockFindUser,
      });

      expect(mockFindUser).not.toHaveBeenCalled();
      expect(result).toEqual({
        user: null,
        error: null,
        migration: false,
      });
    });

    it('should handle empty string idOnTheSource', async () => {
      mockFindUser.mockResolvedValueOnce(null);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        idOnTheSource: '',
      });

      expect(mockFindUser).toHaveBeenCalledWith({
        openidId: 'openid_123',
        openidIssuer: issuer,
      });
      expect(result).toEqual({
        user: null,
        error: null,
        migration: false,
      });
    });

    it('should handle both openidId and idOnTheSource as empty strings', async () => {
      await findOpenIDUser({
        openidId: '',
        findUser: mockFindUser,
        idOnTheSource: '',
        email: 'user@example.com',
      });

      // Should skip primary search and go directly to email search
      expect(mockFindUser).toHaveBeenCalledTimes(1);
      expect(mockFindUser).toHaveBeenCalledWith({ email: 'user@example.com' });
    });

    it('should pass email to findUser for case-insensitive lookup (findUser handles normalization)', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'openid_123',
        openidIssuer: issuer,
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: 'openid_123',
        openidIssuer: issuer,
        findUser: mockFindUser,
        email: 'User@Example.COM',
      });

      expect(mockFindUser).toHaveBeenNthCalledWith(2, { email: 'User@Example.COM' });
      expect(result).toEqual({
        user: mockUser,
        error: null,
        migration: false,
      });
    });

    it('should handle findUser throwing an error', async () => {
      mockFindUser.mockRejectedValueOnce(new Error('Database error'));

      await expect(
        findOpenIDUser({
          openidId: 'openid_123',
          openidIssuer: issuer,
          findUser: mockFindUser,
        }),
      ).rejects.toThrow('Database error');
      expect(recordOpenIDUserLookup).toHaveBeenCalledWith('error', expect.any(Number));
    });

    it('should reject email fallback when openidId is empty and user has a stored openidId', async () => {
      const mockUser: IUser = {
        _id: newId(),
        provider: 'openid',
        openidId: 'existing-real-id',
        email: 'user@example.com',
        username: 'testuser',
      } as IUser;

      mockFindUser.mockResolvedValueOnce(mockUser);

      const result = await findOpenIDUser({
        openidId: '',
        findUser: mockFindUser,
        email: 'user@example.com',
      });

      expect(mockFindUser).toHaveBeenCalledTimes(1);
      expect(mockFindUser).toHaveBeenCalledWith({ email: 'user@example.com' });
      expect(result).toEqual({
        user: null,
        error: ErrorTypes.AUTH_FAILED,
        migration: false,
      });
    });
  });
});

type CapturedFindCommand = {
  find?: unknown;
  filter?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function planContainsStage(value: unknown, stage: string): boolean {
  if (!isRecord(value)) return false;
  if (value.stage === stage) return true;

  return Object.values(value).some((entry) => {
    if (Array.isArray(entry)) return entry.some((item) => planContainsStage(item, stage));
    return planContainsStage(entry, stage);
  });
}

function getTotalDocsExamined(explain: unknown): number | undefined {
  if (!isRecord(explain)) return undefined;
  const executionStats = explain.executionStats;
  if (!isRecord(executionStats)) return undefined;
  const totalDocsExamined = executionStats.totalDocsExamined;
  return typeof totalDocsExamined === 'number' ? totalDocsExamined : undefined;
}

describe('findOpenIDUser Mongo compatibility', () => {
  let mongoServer: MongoMemoryServer;
  let User: mongoose.Model<IUser>;
  let methods: ReturnType<typeof createMethods>;

  const issuer = 'https://issuer.example.com';
  const originalOpenIdIssuer = process.env.OPENID_ISSUER;

  async function seedUsers(count: number) {
    await User.insertMany(
      Array.from({ length: count }, (_, index) => ({
        email: `filler-${index}@example.com`,
        provider: 'openid',
        openidId: `filler-sub-${index}`,
        openidIssuer: issuer,
        idOnTheSource: `filler-oid-${index}`,
      })),
    );
  }

  async function captureFindFilters<T>(run: () => Promise<T>): Promise<{
    result: T;
    filters: unknown[];
  }> {
    const filters: unknown[] = [];
    const client = mongoose.connection.getClient();
    const listener = (event: CommandStartedEvent) => {
      const command = event.command as CapturedFindCommand;
      if (event.commandName === 'find' && command.find === User.collection.name) {
        filters.push(command.filter);
      }
    };

    client.on('commandStarted', listener);
    try {
      const result = await run();
      return { result, filters };
    } finally {
      client.off('commandStarted', listener);
    }
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    /** Each test rebuilds the User indexes explicitly after resetting the database. */
    await mongoose.connect(mongoServer.getUri(), {
      monitorCommands: true,
      autoCreate: false,
      autoIndex: false,
    });
    createModels(mongoose);
    User = mongoose.models.User as mongoose.Model<IUser>;
    methods = createMethods(mongoose);
  });

  afterAll(async () => {
    if (originalOpenIdIssuer == null) {
      delete process.env.OPENID_ISSUER;
    } else {
      process.env.OPENID_ISSUER = originalOpenIdIssuer;
    }
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    process.env.OPENID_ISSUER = issuer;
    await mongoose.connection.dropDatabase();
    await User.syncIndexes();
  });

  it('keeps exact issuer lookup indexable on a seeded user collection', async () => {
    await seedUsers(1500);
    await User.create({
      email: 'target@example.com',
      provider: 'openid',
      openidId: 'target-sub',
      openidIssuer: issuer,
      idOnTheSource: 'target-oid',
    });

    const { result, filters } = await captureFindFilters(() =>
      findOpenIDUser({
        openidId: 'target-sub',
        idOnTheSource: 'target-oid',
        openidIssuer: issuer,
        findUser: methods.findUser,
      }),
    );

    expect(result.user?.email).toBe('target@example.com');
    expect(filters).toEqual([{ openidId: 'target-sub', openidIssuer: issuer }]);

    const explain = await User.findOne(filters[0] as FilterQuery<IUser>).explain('executionStats');
    expect(planContainsStage(explain, 'IXSCAN')).toBe(true);
    expect(getTotalDocsExamined(explain)).toBeLessThanOrEqual(1);
  });

  it('resolves legacy issuer-less users without nested or disjunctive filters', async () => {
    await User.create({
      email: 'legacy@example.com',
      provider: 'openid',
      openidId: 'legacy-sub',
      idOnTheSource: 'legacy-oid',
    });

    const { result, filters } = await captureFindFilters(() =>
      findOpenIDUser({
        openidId: 'legacy-sub',
        idOnTheSource: 'legacy-oid',
        openidIssuer: issuer,
        findUser: methods.findUser,
      }),
    );

    expect(result.user?.email).toBe('legacy@example.com');
    expect(result.migration).toBe(true);
    expect(filters).toEqual([
      { openidId: 'legacy-sub', openidIssuer: issuer },
      { idOnTheSource: 'legacy-oid', openidIssuer: issuer },
      { openidId: 'legacy-sub', openidIssuer: { $exists: false } },
    ]);
  });
});

describe('getOpenIdEmail', () => {
  const originalEmailClaim = process.env.OPENID_EMAIL_CLAIM;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENID_EMAIL_CLAIM;
  });

  afterAll(() => {
    if (originalEmailClaim == null) {
      delete process.env.OPENID_EMAIL_CLAIM;
      return;
    }
    process.env.OPENID_EMAIL_CLAIM = originalEmailClaim;
  });

  it('uses the default claim order', () => {
    expect(
      getOpenIdEmail({
        email: 'user@example.com',
        preferred_username: 'preferred@example.com',
        upn: 'upn@example.com',
      }),
    ).toBe('user@example.com');
  });

  it('returns undefined when default claims are absent', () => {
    expect(getOpenIdEmail({})).toBeUndefined();
  });

  it('skips empty fallback claims', () => {
    expect(
      getOpenIdEmail({
        email: '',
        preferred_username: 'preferred@example.com',
        upn: 'upn@example.com',
      }),
    ).toBe('preferred@example.com');
  });

  it('uses OPENID_EMAIL_CLAIM when present', () => {
    process.env.OPENID_EMAIL_CLAIM = 'custom_identifier';

    expect(
      getOpenIdEmail({
        email: 'user@example.com',
        custom_identifier: 'agent@corp.example.com',
      }),
    ).toBe('agent@corp.example.com');
  });

  it('falls back with a warning when OPENID_EMAIL_CLAIM is missing', () => {
    process.env.OPENID_EMAIL_CLAIM = 'missing_identifier';

    expect(getOpenIdEmail({ email: 'user@example.com' }, 'remoteAgentAuth')).toBe(
      'user@example.com',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('OPENID_EMAIL_CLAIM="missing_identifier" not present in userinfo'),
    );
  });

  it('falls back with a warning when OPENID_EMAIL_CLAIM is not a string', () => {
    process.env.OPENID_EMAIL_CLAIM = 'groups';

    expect(getOpenIdEmail({ email: 'user@example.com', groups: ['a'] })).toBe('user@example.com');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'OPENID_EMAIL_CLAIM="groups" resolved to a non-string value (type: object)',
      ),
    );
  });
});
