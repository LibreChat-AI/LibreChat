import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createTokenMethods } from './token';
import tokenSchema from '~/schema/token';

/** Mocking logger */
jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let Token: mongoose.Model<t.IToken>;
let methods: ReturnType<typeof createTokenMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  /** Register models */
  Token = mongoose.models.Token || mongoose.model<t.IToken>('Token', tokenSchema);

  /** Initialize methods */
  methods = createTokenMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('Token Methods - Detailed Tests', () => {
  describe('createToken', () => {
    test('should create a token with correct expiry time', async () => {
      const userId = new mongoose.Types.ObjectId();
      const tokenData = {
        token: 'test-token-123',
        userId: userId,
        email: 'test@example.com',
        expiresIn: 3600, // 1 hour
      };

      const token = await methods.createToken(tokenData);

      expect(token).toBeDefined();
      expect(token.token).toBe(tokenData.token);
      expect(token.userId.toString()).toBe(userId.toString());
      expect(token.email).toBe(tokenData.email);

      // Check expiry time
      const expectedExpiry = new Date(token.createdAt.getTime() + tokenData.expiresIn * 1000);
      expect(token.expiresAt.getTime()).toBe(expectedExpiry.getTime());
    });

    test('should create token with all required fields', async () => {
      const userId = new mongoose.Types.ObjectId();
      const tokenData = {
        token: 'minimal-token',
        userId: userId,
        expiresIn: 1800,
      };

      const token = await methods.createToken(tokenData);

      expect(token).toBeDefined();
      expect(token.token).toBe(tokenData.token);
      expect(token.userId.toString()).toBe(userId.toString());
      expect(token.email).toBeUndefined();
    });

    test('should create token with identifier field', async () => {
      const userId = new mongoose.Types.ObjectId();
      const tokenData = {
        token: 'identifier-token',
        userId: userId,
        identifier: 'oauth-identifier-123',
        expiresIn: 7200,
      };

      const token = await methods.createToken(tokenData);

      expect(token).toBeDefined();
      expect(token.identifier).toBe(tokenData.identifier);
    });
  });

  describe('findToken', () => {
    let user1Id: mongoose.Types.ObjectId;
    let user2Id: mongoose.Types.ObjectId;

    beforeEach(async () => {
      user1Id = new mongoose.Types.ObjectId();
      user2Id = new mongoose.Types.ObjectId();

      await Token.create([
        {
          token: 'token-1',
          userId: user1Id,
          email: 'user1@example.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'token-2',
          userId: user2Id,
          email: 'user2@example.com',
          identifier: 'oauth-123',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'token-3',
          userId: user1Id,
          email: 'user1-alt@example.com', // Different email for realistic scenario
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      ]);
    });

    test('should find token by token value', async () => {
      const found = await methods.findToken({ token: 'token-1' });

      expect(found).toBeDefined();
      expect(found?.token).toBe('token-1');
      expect(found?.userId.toString()).toBe(user1Id.toString());
    });

    test('should find token by userId', async () => {
      const found = await methods.findToken({ userId: user2Id.toString() });

      expect(found).toBeDefined();
      expect(found?.token).toBe('token-2');
      expect(found?.email).toBe('user2@example.com');
    });

    test('should find token by email', async () => {
      const found = await methods.findToken({ email: 'user2@example.com' });

      expect(found).toBeDefined();
      expect(found?.token).toBe('token-2');
      expect(found?.userId.toString()).toBe(user2Id.toString());
    });

    test('should find tokens with explicitly absent optional fields', async () => {
      const legacyUserId = new mongoose.Types.ObjectId();
      await Token.create([
        {
          token: 'legacy-reset-token',
          userId: legacyUserId,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'legacy-identified-token',
          userId: legacyUserId,
          identifier: 'oauth-legacy',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      ]);

      const found = await methods.findToken({
        userId: legacyUserId.toString(),
        email: null,
        identifier: null,
        type: null,
      });

      expect(found).toBeDefined();
      expect(found?.token).toBe('legacy-reset-token');
    });

    test('should find token by identifier', async () => {
      const found = await methods.findToken({ identifier: 'oauth-123' });

      expect(found).toBeDefined();
      expect(found?.token).toBe('token-2');
      expect(found?.identifier).toBe('oauth-123');
    });

    test('should find token by multiple criteria (AND condition)', async () => {
      const found = await methods.findToken({
        userId: user1Id.toString(),
        email: 'user1@example.com',
      });

      expect(found).toBeDefined();
      expect(found?.token).toBe('token-1'); // Should find the only token matching both criteria
    });

    test('should return null for non-existent token', async () => {
      const found = await methods.findToken({ token: 'non-existent' });

      expect(found).toBeNull();
    });

    test('should return null when criteria do not match together', async () => {
      const found = await methods.findToken({
        userId: user1Id.toString(),
        email: 'user2@example.com', // Mismatched email
      });

      expect(found).toBeNull();
    });

    test('should find most recent token with sort option', async () => {
      const recentUserId = new mongoose.Types.ObjectId();

      // Create tokens with different timestamps
      const oldDate = new Date(Date.now() - 7200000); // 2 hours ago
      const midDate = new Date(Date.now() - 3600000); // 1 hour ago
      const newDate = new Date(); // now

      await Token.create([
        {
          token: 'old-token',
          userId: recentUserId,
          email: 'recent@example.com',
          createdAt: oldDate,
          expiresAt: new Date(oldDate.getTime() + 86400000),
        },
        {
          token: 'mid-token',
          userId: recentUserId,
          email: 'recent@example.com',
          createdAt: midDate,
          expiresAt: new Date(midDate.getTime() + 86400000),
        },
        {
          token: 'new-token',
          userId: recentUserId,
          email: 'recent@example.com',
          createdAt: newDate,
          expiresAt: new Date(newDate.getTime() + 86400000),
        },
      ]);

      // Find most recent token for the user with sort option
      const found = await methods.findToken(
        { userId: recentUserId.toString() },
        { sort: { createdAt: -1 } },
      );

      expect(found).toBeDefined();
      expect(found?.token).toBe('new-token');
      expect(found?.createdAt.getTime()).toBe(newDate.getTime());
    });

    test('should find oldest token with ascending sort', async () => {
      const sortUserId = new mongoose.Types.ObjectId();

      const oldDate = new Date(Date.now() - 7200000);
      const midDate = new Date(Date.now() - 3600000);
      const newDate = new Date();

      await Token.create([
        {
          token: 'sort-old',
          userId: sortUserId,
          email: 'sort@example.com',
          createdAt: oldDate,
          expiresAt: new Date(oldDate.getTime() + 86400000),
        },
        {
          token: 'sort-mid',
          userId: sortUserId,
          email: 'sort@example.com',
          createdAt: midDate,
          expiresAt: new Date(midDate.getTime() + 86400000),
        },
        {
          token: 'sort-new',
          userId: sortUserId,
          email: 'sort@example.com',
          createdAt: newDate,
          expiresAt: new Date(newDate.getTime() + 86400000),
        },
      ]);

      // Find oldest token with ascending sort
      const found = await methods.findToken(
        { userId: sortUserId.toString() },
        { sort: { createdAt: 1 } },
      );

      expect(found).toBeDefined();
      expect(found?.token).toBe('sort-old');
      expect(found?.createdAt.getTime()).toBe(oldDate.getTime());
    });

    test('should handle multiple sort criteria', async () => {
      const multiSortUserId = new mongoose.Types.ObjectId();
      const sameDate = new Date();

      await Token.create([
        {
          token: 'token-a',
          userId: multiSortUserId,
          email: 'z@example.com',
          createdAt: sameDate,
          expiresAt: new Date(sameDate.getTime() + 86400000),
        },
        {
          token: 'token-b',
          userId: multiSortUserId,
          email: 'a@example.com',
          createdAt: sameDate,
          expiresAt: new Date(sameDate.getTime() + 86400000),
        },
        {
          token: 'token-c',
          userId: multiSortUserId,
          email: 'm@example.com',
          createdAt: new Date(Date.now() - 1000), // slightly older
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      // Sort by createdAt descending, then by email ascending
      const found = await methods.findToken(
        { userId: multiSortUserId.toString() },
        { sort: { createdAt: -1, email: 1 } },
      );

      expect(found).toBeDefined();
      // Should get token-b (same recent date but 'a@example.com' comes first alphabetically)
      expect(found?.token).toBe('token-b');
      expect(found?.email).toBe('a@example.com');
    });

    test('should find token with projection option', async () => {
      const projectionUserId = new mongoose.Types.ObjectId();

      await Token.create({
        token: 'projection-token',
        userId: projectionUserId,
        email: 'projection@example.com',
        identifier: 'oauth-projection',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      });

      // Find token with projection to only include specific fields
      const found = await methods.findToken(
        { userId: projectionUserId.toString() },
        { projection: { token: 1, email: 1 } },
      );

      expect(found).toBeDefined();
      expect(found?.token).toBe('projection-token');
      expect(found?.email).toBe('projection@example.com');
      // Note: _id is usually included by default unless explicitly excluded
    });

    test('should respect combined query options', async () => {
      const combinedUserId = new mongoose.Types.ObjectId();

      // Create multiple tokens with different attributes
      await Token.create([
        {
          token: 'combined-1',
          userId: combinedUserId,
          email: 'combined1@example.com',
          createdAt: new Date(Date.now() - 7200000),
          expiresAt: new Date(Date.now() + 86400000),
        },
        {
          token: 'combined-2',
          userId: combinedUserId,
          email: 'combined2@example.com',
          createdAt: new Date(Date.now() - 3600000),
          expiresAt: new Date(Date.now() + 86400000),
        },
        {
          token: 'combined-3',
          userId: combinedUserId,
          email: 'combined3@example.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      // Use multiple query options together
      const found = await methods.findToken(
        { userId: combinedUserId.toString() },
        {
          sort: { createdAt: -1 },
          projection: { token: 1, createdAt: 1 },
        },
      );

      expect(found).toBeDefined();
      expect(found?.token).toBe('combined-3'); // Most recent
      expect(found?.createdAt).toBeDefined();
    });
  });

  describe('updateToken', () => {
    let updateUserId: mongoose.Types.ObjectId;

    beforeEach(async () => {
      updateUserId = new mongoose.Types.ObjectId();
      await Token.create({
        token: 'update-token',
        userId: updateUserId,
        email: 'update@example.com',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      });
    });

    test('should update token by token value', async () => {
      const updated = await methods.updateToken(
        { token: 'update-token' },
        { email: 'newemail@example.com' },
      );

      expect(updated).toBeDefined();
      expect(updated?.email).toBe('newemail@example.com');
      expect(updated?.userId.toString()).toBe(updateUserId.toString()); // Unchanged
    });

    test('should update token by userId', async () => {
      const updated = await methods.updateToken(
        { userId: updateUserId.toString() },
        { email: 'newemail@example.com' },
      );

      expect(updated).toBeDefined();
      expect(updated?.email).toBe('newemail@example.com');
      expect(updated?.token).toBe('update-token'); // Unchanged
    });

    test('should return null for non-existent token', async () => {
      const updated = await methods.updateToken(
        { token: 'non-existent' },
        { email: 'newemail@example.com' },
      );

      expect(updated).toBeNull();
    });

    test('should condition updates on the OAuth credential-set metadata selector', async () => {
      await Token.updateOne(
        { token: 'update-token' },
        { $set: { metadata: { credential_set_id: 'generation-a' } } },
      );

      const staleUpdate = await methods.updateToken(
        {
          token: 'update-token',
          metadataCredentialSetId: 'generation-b',
        },
        { email: 'stale@example.com' },
      );
      expect(staleUpdate).toBeNull();

      const currentUpdate = await methods.updateToken(
        {
          token: 'update-token',
          metadataCredentialSetId: 'generation-a',
        },
        { email: 'current@example.com' },
      );
      expect(currentUpdate?.email).toBe('current@example.com');
    });

    test('should condition legacy OAuth updates on a missing credential-set selector', async () => {
      const legacyUpdate = await methods.updateToken(
        {
          token: 'update-token',
          metadataCredentialSetId: null,
        },
        { email: 'claimed@example.com' },
      );
      expect(legacyUpdate?.email).toBe('claimed@example.com');

      await Token.updateOne(
        { token: 'update-token' },
        { $set: { metadata: { credential_set_id: 'generation-a' } } },
      );
      const staleLegacyUpdate = await methods.updateToken(
        {
          token: 'update-token',
          metadataCredentialSetId: null,
        },
        { email: 'stale@example.com' },
      );
      expect(staleLegacyUpdate).toBeNull();
    });

    test('should update expiresAt when expiresIn is provided', async () => {
      const beforeUpdate = Date.now();
      const newExpiresIn = 7200;

      const updated = await methods.updateToken(
        { token: 'update-token' },
        { expiresIn: newExpiresIn },
      );

      const afterUpdate = Date.now();

      expect(updated).toBeDefined();
      expect(updated?.expiresAt).toBeDefined();

      const expectedMinExpiry = beforeUpdate + newExpiresIn * 1000;
      const expectedMaxExpiry = afterUpdate + newExpiresIn * 1000;

      expect(updated!.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMinExpiry);
      expect(updated!.expiresAt.getTime()).toBeLessThanOrEqual(expectedMaxExpiry);
    });

    test('should not modify expiresAt when expiresIn is not provided', async () => {
      const original = await Token.findOne({ token: 'update-token' });
      const originalExpiresAt = original!.expiresAt.getTime();

      const updated = await methods.updateToken(
        { token: 'update-token' },
        { email: 'changed@example.com' },
      );

      expect(updated).toBeDefined();
      expect(updated?.email).toBe('changed@example.com');
      expect(updated!.expiresAt.getTime()).toBe(originalExpiresAt);
    });
  });

  describe('deleteTokens', () => {
    let user1Id: mongoose.Types.ObjectId;
    let user2Id: mongoose.Types.ObjectId;
    let user3Id: mongoose.Types.ObjectId;
    let oauthUserId: mongoose.Types.ObjectId;

    beforeEach(async () => {
      user1Id = new mongoose.Types.ObjectId();
      user2Id = new mongoose.Types.ObjectId();
      user3Id = new mongoose.Types.ObjectId();
      oauthUserId = new mongoose.Types.ObjectId();

      await Token.create([
        {
          token: 'verify-token-1',
          userId: user1Id,
          email: 'user1@example.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'verify-token-2',
          userId: user2Id,
          email: 'user2@example.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'verify-token-3',
          userId: user3Id,
          email: 'user3@example.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'oauth-token',
          userId: oauthUserId,
          identifier: 'oauth-identifier-456',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      ]);
    });

    test('should delete only tokens matching specific token value', async () => {
      const result = await methods.deleteTokens({ token: 'verify-token-1' });

      expect(result.deletedCount).toBe(1);

      // Verify other tokens still exist
      const remainingTokens = await Token.find({});
      expect(remainingTokens).toHaveLength(3);
      expect(remainingTokens.find((t) => t.token === 'verify-token-2')).toBeDefined();
      expect(remainingTokens.find((t) => t.token === 'verify-token-3')).toBeDefined();
      expect(remainingTokens.find((t) => t.token === 'oauth-token')).toBeDefined();
    });

    test('should delete only tokens matching specific userId', async () => {
      // Create another token for user-1
      await Token.create({
        token: 'another-user-1-token',
        userId: user1Id,
        email: 'user1@example.com',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      });

      const result = await methods.deleteTokens({ userId: user1Id.toString() });

      expect(result.deletedCount).toBe(2); // Both tokens for user-1

      const remainingTokens = await Token.find({});
      expect(remainingTokens).toHaveLength(3);
      expect(remainingTokens.every((t) => t.userId.toString() !== user1Id.toString())).toBe(true);
    });

    test('should delete only tokens matching specific email', async () => {
      const result = await methods.deleteTokens({ email: 'user2@example.com' });

      expect(result.deletedCount).toBe(1);

      const remainingTokens = await Token.find({});
      expect(remainingTokens).toHaveLength(3);
      expect(remainingTokens.find((t) => t.email === 'user2@example.com')).toBeUndefined();
    });

    test('should delete only tokens matching specific identifier', async () => {
      const result = await methods.deleteTokens({ identifier: 'oauth-identifier-456' });

      expect(result.deletedCount).toBe(1);

      const remainingTokens = await Token.find({});
      expect(remainingTokens).toHaveLength(3);
      expect(remainingTokens.find((t) => t.identifier === 'oauth-identifier-456')).toBeUndefined();
    });

    test('should condition OAuth client deletion on the credential-set metadata selector', async () => {
      const identifier = 'mcp:test-server:client';
      await Token.create({
        token: 'encrypted-client-registration',
        userId: oauthUserId,
        type: 'mcp_oauth_client',
        identifier,
        metadata: { credential_set_id: 'generation-b' },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      });

      const staleDelete = await methods.deleteTokens({
        userId: oauthUserId.toString(),
        type: 'mcp_oauth_client',
        identifier,
        metadataCredentialSetId: 'generation-a',
      });
      expect(staleDelete.deletedCount).toBe(0);
      expect(await Token.exists({ token: 'encrypted-client-registration' })).not.toBeNull();

      const currentDelete = await methods.deleteTokens({
        userId: oauthUserId.toString(),
        type: 'mcp_oauth_client',
        identifier,
        metadataCredentialSetId: 'generation-b',
      });
      expect(currentDelete.deletedCount).toBe(1);
      expect(await Token.exists({ token: 'encrypted-client-registration' })).toBeNull();
    });

    test('should delete only a legacy OAuth token with a missing credential-set selector', async () => {
      const identifier = 'mcp:test-server:refresh';
      await Token.create([
        {
          token: 'legacy-refresh-token',
          userId: oauthUserId,
          type: 'mcp_oauth_refresh',
          identifier,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'tagged-refresh-token',
          userId: oauthUserId,
          type: 'mcp_oauth_refresh',
          identifier,
          metadata: { credential_set_id: 'generation-b' },
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      ]);

      const result = await methods.deleteTokens({
        userId: oauthUserId.toString(),
        type: 'mcp_oauth_refresh',
        identifier,
        token: 'legacy-refresh-token',
        metadataCredentialSetId: null,
      });

      expect(result.deletedCount).toBe(1);
      expect(await Token.exists({ token: 'legacy-refresh-token' })).toBeNull();
      expect(await Token.exists({ token: 'tagged-refresh-token' })).not.toBeNull();
    });

    test('should delete tokens matching an identifier pattern', async () => {
      await Token.create([
        {
          token: 'action-access-token',
          userId: oauthUserId,
          type: 'oauth',
          identifier: `${oauthUserId.toString()}:action-1`,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'other-action-token',
          userId: oauthUserId,
          type: 'oauth',
          identifier: `${oauthUserId.toString()}:action-2`,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      ]);

      const result = await methods.deleteTokens({
        type: 'oauth',
        identifier: /^[^:]+:action-1$/,
      });

      expect(result.deletedCount).toBe(1);

      const remaining = await Token.find({ userId: oauthUserId, type: 'oauth' });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].identifier).toBe(`${oauthUserId.toString()}:action-2`);
    });

    test('should not delete tokens when undefined fields are passed', async () => {
      // This is the critical test case for the bug fix
      const result = await methods.deleteTokens({
        token: 'verify-token-1',
        identifier: undefined,
        userId: undefined,
        email: undefined,
      });

      expect(result.deletedCount).toBe(1); // Only the token with 'verify-token-1'

      const remainingTokens = await Token.find({});
      expect(remainingTokens).toHaveLength(3);
    });

    test('should delete only tokens with explicitly absent optional fields', async () => {
      const legacyUserId = new mongoose.Types.ObjectId();
      await Token.create([
        {
          token: 'legacy-reset-token',
          userId: legacyUserId,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'legacy-identified-token',
          userId: legacyUserId,
          identifier: 'oauth-legacy',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'typed-reset-token',
          userId: legacyUserId,
          type: 'password_reset',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      ]);

      const result = await methods.deleteTokens({
        userId: legacyUserId.toString(),
        email: null,
        identifier: null,
        type: null,
      });

      expect(result.deletedCount).toBe(1);

      const remainingTokens = await Token.find({ userId: legacyUserId });
      expect(remainingTokens).toHaveLength(2);
      expect(remainingTokens.find((t) => t.token === 'legacy-reset-token')).toBeUndefined();
      expect(remainingTokens.find((t) => t.token === 'legacy-identified-token')).toBeDefined();
      expect(remainingTokens.find((t) => t.token === 'typed-reset-token')).toBeDefined();
    });

    test('should only delete tokens matching ALL provided fields (AND semantics)', async () => {
      await Token.create({
        token: 'extra-user2-token',
        userId: user2Id,
        email: 'different@example.com',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      });

      const result = await methods.deleteTokens({
        token: 'verify-token-2',
        userId: user2Id.toString(),
      });

      expect(result.deletedCount).toBe(1);

      const remainingTokens = await Token.find({});
      expect(remainingTokens).toHaveLength(4);
      expect(remainingTokens.find((t) => t.token === 'verify-token-1')).toBeDefined();
      expect(remainingTokens.find((t) => t.token === 'extra-user2-token')).toBeDefined();
    });

    test('should delete tokens by type and userId together', async () => {
      await Token.create([
        {
          token: 'mcp-oauth-token',
          userId: oauthUserId,
          type: 'mcp_oauth',
          identifier: 'mcp:test-server',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'mcp-refresh-token',
          userId: oauthUserId,
          type: 'mcp_oauth_refresh',
          identifier: 'mcp:test-server:refresh',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      ]);

      const result = await methods.deleteTokens({
        userId: oauthUserId.toString(),
        type: 'mcp_oauth',
        identifier: 'mcp:test-server',
      });

      expect(result.deletedCount).toBe(1);

      const remaining = await Token.find({ userId: oauthUserId });
      expect(remaining).toHaveLength(2);
      expect(remaining.find((t) => t.type === 'mcp_oauth')).toBeUndefined();
      expect(remaining.find((t) => t.type === 'mcp_oauth_refresh')).toBeDefined();
    });

    test('should not delete cross-user tokens with matching identifier', async () => {
      const userAId = new mongoose.Types.ObjectId();
      const userBId = new mongoose.Types.ObjectId();

      await Token.create([
        {
          token: 'user-a-mcp',
          userId: userAId,
          type: 'mcp_oauth',
          identifier: 'mcp:shared-server',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        {
          token: 'user-b-mcp',
          userId: userBId,
          type: 'mcp_oauth',
          identifier: 'mcp:shared-server',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      ]);

      await methods.deleteTokens({
        userId: userAId.toString(),
        type: 'mcp_oauth',
        identifier: 'mcp:shared-server',
      });

      const userBTokens = await Token.find({ userId: userBId });
      expect(userBTokens).toHaveLength(1);
      expect(userBTokens[0].token).toBe('user-b-mcp');
    });

    test('should throw error when no query parameters provided', async () => {
      await expect(methods.deleteTokens({})).rejects.toThrow(
        'At least one query parameter must be provided',
      );

      // Verify no tokens were deleted
      const tokens = await Token.find({});
      expect(tokens).toHaveLength(4);
    });

    test('should handle deletion when no tokens match', async () => {
      const result = await methods.deleteTokens({ token: 'non-existent-token' });

      expect(result.deletedCount).toBe(0);

      // Verify all tokens still exist
      const tokens = await Token.find({});
      expect(tokens).toHaveLength(4);
    });

    test('should handle email verification scenario correctly', async () => {
      // This simulates the exact scenario from the bug report
      // Multiple users register and get verification tokens
      const newUser1Id = new mongoose.Types.ObjectId();
      const newUser2Id = new mongoose.Types.ObjectId();
      const newUser3Id = new mongoose.Types.ObjectId();

      await Token.create([
        {
          token: 'email-verify-token-1',
          userId: newUser1Id,
          email: 'newuser1@example.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000), // 24 hours
        },
        {
          token: 'email-verify-token-2',
          userId: newUser2Id,
          email: 'newuser2@example.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
        },
        {
          token: 'email-verify-token-3',
          userId: newUser3Id,
          email: 'newuser3@example.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      // User 2 verifies their email - only their token should be deleted
      const result = await methods.deleteTokens({ token: 'email-verify-token-2' });

      expect(result.deletedCount).toBe(1);

      // Verify other users' tokens still exist
      const remainingTokens = await Token.find({ token: { $regex: /^email-verify-token-/ } });
      expect(remainingTokens).toHaveLength(2);
      expect(remainingTokens.find((t) => t.token === 'email-verify-token-1')).toBeDefined();
      expect(remainingTokens.find((t) => t.token === 'email-verify-token-3')).toBeDefined();
      expect(remainingTokens.find((t) => t.token === 'email-verify-token-2')).toBeUndefined();
    });
  });

  describe('Email Normalization', () => {
    let normUserId: mongoose.Types.ObjectId;

    beforeEach(async () => {
      normUserId = new mongoose.Types.ObjectId();

      // Create token with lowercase email (as stored in DB)
      await Token.create({
        token: 'norm-token-1',
        userId: normUserId,
        email: 'john.doe@example.com',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      });
    });

    describe('findToken email normalization', () => {
      test('should find token by email with different case (case-insensitive)', async () => {
        const foundUpper = await methods.findToken({ email: 'JOHN.DOE@EXAMPLE.COM' });
        const foundMixed = await methods.findToken({ email: 'John.Doe@Example.COM' });
        const foundLower = await methods.findToken({ email: 'john.doe@example.com' });

        expect(foundUpper).toBeDefined();
        expect(foundUpper?.token).toBe('norm-token-1');

        expect(foundMixed).toBeDefined();
        expect(foundMixed?.token).toBe('norm-token-1');

        expect(foundLower).toBeDefined();
        expect(foundLower?.token).toBe('norm-token-1');
      });

      test('should find token by email with leading/trailing whitespace', async () => {
        const foundWithSpaces = await methods.findToken({ email: '  john.doe@example.com  ' });
        const foundWithTabs = await methods.findToken({ email: '\tjohn.doe@example.com\t' });

        expect(foundWithSpaces).toBeDefined();
        expect(foundWithSpaces?.token).toBe('norm-token-1');

        expect(foundWithTabs).toBeDefined();
        expect(foundWithTabs?.token).toBe('norm-token-1');
      });

      test('should find token by email with both case difference and whitespace', async () => {
        const found = await methods.findToken({ email: '  JOHN.DOE@EXAMPLE.COM  ' });

        expect(found).toBeDefined();
        expect(found?.token).toBe('norm-token-1');
      });

      test('should find token with combined email and other criteria', async () => {
        const found = await methods.findToken({
          userId: normUserId.toString(),
          email: 'John.Doe@Example.COM',
        });

        expect(found).toBeDefined();
        expect(found?.token).toBe('norm-token-1');
      });
    });

    describe('deleteTokens email normalization', () => {
      test('should delete token by email with different case', async () => {
        const result = await methods.deleteTokens({ email: 'JOHN.DOE@EXAMPLE.COM' });

        expect(result.deletedCount).toBe(1);

        const remaining = await Token.find({});
        expect(remaining).toHaveLength(0);
      });

      test('should delete token by email with whitespace', async () => {
        const result = await methods.deleteTokens({ email: '  john.doe@example.com  ' });

        expect(result.deletedCount).toBe(1);

        const remaining = await Token.find({});
        expect(remaining).toHaveLength(0);
      });

      test('should delete token by email with case and whitespace combined', async () => {
        const result = await methods.deleteTokens({ email: '  John.Doe@EXAMPLE.COM  ' });

        expect(result.deletedCount).toBe(1);

        const remaining = await Token.find({});
        expect(remaining).toHaveLength(0);
      });

      test('should only delete matching token when using normalized email', async () => {
        // Create additional token with different email
        await Token.create({
          token: 'norm-token-2',
          userId: new mongoose.Types.ObjectId(),
          email: 'jane.doe@example.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        });

        const result = await methods.deleteTokens({ email: 'JOHN.DOE@EXAMPLE.COM' });

        expect(result.deletedCount).toBe(1);

        const remaining = await Token.find({});
        expect(remaining).toHaveLength(1);
        expect(remaining[0].email).toBe('jane.doe@example.com');
      });
    });

    describe('Email verification flow with normalization', () => {
      test('should handle OpenID provider email case mismatch scenario', async () => {
        /**
         * Simulate the exact bug scenario:
         * 1. User registers with email stored as lowercase
         * 2. OpenID provider returns email with different casing
         * 3. System should still find and delete the correct token
         */
        const userId = new mongoose.Types.ObjectId();

        // Token created during registration (email stored lowercase)
        await Token.create({
          token: 'verification-token',
          userId: userId,
          email: 'user@company.com',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
        });

        // OpenID provider returns email with different case
        const emailFromProvider = 'User@Company.COM';

        // Should find the token despite case mismatch
        const found = await methods.findToken({ email: emailFromProvider });
        expect(found).toBeDefined();
        expect(found?.token).toBe('verification-token');

        // Should delete the token despite case mismatch
        const deleted = await methods.deleteTokens({ email: emailFromProvider });
        expect(deleted.deletedCount).toBe(1);
      });

      test('should handle resend verification email with case mismatch', async () => {
        const userId = new mongoose.Types.ObjectId();

        // Old verification token
        await Token.create({
          token: 'old-verification',
          userId: userId,
          email: 'john.smith@enterprise.com',
          createdAt: new Date(Date.now() - 3600000),
          expiresAt: new Date(Date.now() + 82800000),
        });

        // User requests resend with different email casing
        const userInputEmail = '  John.Smith@ENTERPRISE.COM  ';

        // Delete old tokens for this email
        const deleted = await methods.deleteTokens({ email: userInputEmail });
        expect(deleted.deletedCount).toBe(1);

        // Verify token was actually deleted
        const remaining = await Token.find({ userId });
        expect(remaining).toHaveLength(0);
      });
    });
  });
});

describe('Token email normalization', () => {
  const userId = new mongoose.Types.ObjectId();

  const createFor = (email: string) =>
    methods.createToken({
      userId,
      email,
      token: 'hashed-token-value',
      expiresIn: 3600,
    });

  it('stores the email normalized so reads can find it again', async () => {
    await createFor('User@Example.COM');

    const stored = await Token.findOne({ userId });
    expect(stored?.email).toBe('user@example.com');
  });

  it('trims surrounding whitespace on write', async () => {
    await createFor('  spaced@example.com  ');

    const stored = await Token.findOne({ userId });
    expect(stored?.email).toBe('spaced@example.com');
  });

  it('finds a token created with mixed case, whatever case the lookup uses', async () => {
    await createFor('User@Example.COM');

    for (const lookup of ['User@Example.COM', 'user@example.com', 'USER@EXAMPLE.COM']) {
      const found = await methods.findToken({ token: 'hashed-token-value', email: lookup });
      expect(found).not.toBeNull();
    }
  });

  it('finds a token created with padding when the lookup is clean', async () => {
    await createFor('  spaced@example.com  ');

    const found = await methods.findToken({
      token: 'hashed-token-value',
      email: 'spaced@example.com',
    });

    expect(found).not.toBeNull();
  });

  it('deletes a token created with mixed case', async () => {
    await createFor('User@Example.COM');

    const result = await methods.deleteTokens({ email: 'user@example.com' });

    expect(result.deletedCount).toBe(1);
    expect(await Token.countDocuments({ userId })).toBe(0);
  });

  it('leaves a token written without an email alone', async () => {
    await methods.createToken({
      userId,
      token: 'no-email-token',
      expiresIn: 3600,
    });

    const stored = await Token.findOne({ userId });
    expect(stored?.email).toBeUndefined();
  });

  it('leaves an explicitly null email as null, which the read side matches on', async () => {
    /** `TokenCreateData.email` is `string | undefined`, so a null is only reachable by
     *  writing the model directly — but `findToken` and `deleteTokens` both branch on
     *  `email === null`, so the setters must not coerce it into something else. */
    await Token.create({
      userId,
      email: null,
      token: 'null-email-token',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    });

    const stored = await Token.findOne({ userId });
    expect(stored?.email).toBeNull();

    const found = await methods.findToken({ token: 'null-email-token', email: null });
    expect(found).not.toBeNull();
  });
});
