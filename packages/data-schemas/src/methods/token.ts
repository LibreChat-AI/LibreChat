import type { QueryOptions } from 'mongoose';
import { IToken, TokenCreateData, TokenQuery, TokenUpdateData, TokenDeleteResult } from '~/types';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

// Factory function that takes mongoose instance and returns the methods
export function createTokenMethods(mongoose: typeof import('mongoose')): {
  findToken: (query: TokenQuery, options?: QueryOptions) => Promise<IToken | null>;
  createToken: (tokenData: TokenCreateData) => Promise<IToken>;
  replaceTokenIfCurrent: (
    scope: string,
    expectedToken: string | null,
    tokenData: TokenCreateData,
  ) => Promise<boolean>;
  updateToken: (query: TokenQuery, updateData: TokenUpdateData) => Promise<IToken | null>;
  deleteTokens: (query: TokenQuery) => Promise<TokenDeleteResult>;
} {
  let indexPromise: Promise<unknown> | null = null;

  function ensureIndexes(): Promise<unknown> {
    if (!indexPromise) {
      indexPromise = createIndexesWithRetry(mongoose.models.Token).catch((error: unknown) => {
        indexPromise = null;
        throw error;
      });
    }
    return indexPromise;
  }

  /**
   * Creates a new Token instance.
   */
  async function createToken(tokenData: TokenCreateData): Promise<IToken> {
    try {
      const Token = mongoose.models.Token;
      const currentTime = new Date();
      const expiresAt = new Date(currentTime.getTime() + tokenData.expiresIn * 1000);

      const newTokenData = {
        ...tokenData,
        createdAt: currentTime,
        expiresAt,
      };

      return await Token.create(newTokenData);
    } catch (error) {
      logger.debug('An error occurred while creating token:', error);
      throw error;
    }
  }

  /**
   * Atomically replaces the scoped token only when it still matches the token
   * observed by the caller. A null expectation succeeds only when the scope is absent.
   */
  async function replaceTokenIfCurrent(
    scope: string,
    expectedToken: string | null,
    tokenData: TokenCreateData,
  ): Promise<boolean> {
    try {
      const Token = mongoose.models.Token;
      await ensureIndexes();
      const currentTime = new Date();
      const { expiresIn, ...storedTokenData } = tokenData;
      const replacement = {
        ...storedTokenData,
        scope,
        createdAt: currentTime,
        expiresAt: new Date(currentTime.getTime() + expiresIn * 1000),
      };
      const query = {
        scope,
        token: expectedToken ?? tokenData.token,
      };

      try {
        const replacedToken = await Token.findOneAndUpdate(
          query,
          expectedToken === null ? { $setOnInsert: replacement } : { $set: replacement },
          {
            new: true,
            upsert: expectedToken === null,
            runValidators: true,
            setDefaultsOnInsert: true,
          },
        );
        return replacedToken !== null;
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return false;
        }
        throw error;
      }
    } catch (error) {
      logger.debug('An error occurred while conditionally replacing token:', error);
      throw error;
    }
  }

  /**
   * Updates a Token document that matches the provided query.
   */
  async function updateToken(
    query: TokenQuery,
    updateData: TokenUpdateData,
  ): Promise<IToken | null> {
    try {
      const Token = mongoose.models.Token;
      const { metadataCredentialSetId, ...tokenQuery } = query;
      const dbQuery: Record<string, unknown> = { ...tokenQuery };
      if (metadataCredentialSetId !== undefined) {
        dbQuery['metadata.credential_set_id'] = metadataCredentialSetId;
      }

      const dataToUpdate = { ...updateData };
      if (updateData?.expiresIn !== undefined) {
        dataToUpdate.expiresAt = new Date(Date.now() + updateData.expiresIn * 1000);
      }

      return await Token.findOneAndUpdate(dbQuery, dataToUpdate, { new: true });
    } catch (error) {
      logger.debug('An error occurred while updating token:', error);
      throw error;
    }
  }

  /** Deletes all Token documents matching every provided field (AND semantics). */
  async function deleteTokens(query: TokenQuery): Promise<TokenDeleteResult> {
    try {
      const Token = mongoose.models.Token;
      const conditions = [];

      if (query.userId !== undefined) {
        conditions.push({ userId: query.userId });
      }
      if (query.token !== undefined) {
        conditions.push({ token: query.token });
      }
      if (query.email !== undefined) {
        const email = query.email === null ? null : query.email.trim().toLowerCase();
        conditions.push({ email });
      }
      if (query.type !== undefined) {
        conditions.push({ type: query.type });
      }
      if (query.scope !== undefined) {
        conditions.push({ scope: query.scope });
      }
      if (query.identifier !== undefined) {
        conditions.push({ identifier: query.identifier });
      }
      if (query.metadataCredentialSetId !== undefined) {
        conditions.push({ 'metadata.credential_set_id': query.metadataCredentialSetId });
      }

      if (conditions.length === 0) {
        throw new Error('At least one query parameter must be provided');
      }

      return await Token.deleteMany({
        $and: conditions,
      });
    } catch (error) {
      logger.debug('An error occurred while deleting tokens:', error);
      throw error;
    }
  }

  /**
   * Finds a Token document that matches the provided query.
   * Email is automatically normalized to lowercase for case-insensitive matching.
   */
  async function findToken(query: TokenQuery, options?: QueryOptions): Promise<IToken | null> {
    try {
      const Token = mongoose.models.Token;
      const conditions = [];

      if (query.userId) {
        conditions.push({ userId: query.userId });
      }
      if (query.token) {
        conditions.push({ token: query.token });
      }
      if (query.email !== undefined) {
        const email = query.email === null ? null : query.email.trim().toLowerCase();
        conditions.push({ email });
      }
      if (query.type !== undefined) {
        conditions.push({ type: query.type });
      }
      if (query.scope !== undefined) {
        conditions.push({ scope: query.scope });
      }
      if (query.identifier !== undefined) {
        conditions.push({ identifier: query.identifier });
      }
      if (query.metadataCredentialSetId !== undefined) {
        conditions.push({ 'metadata.credential_set_id': query.metadataCredentialSetId });
      }

      const token = await Token.findOne({ $and: conditions }, null, options).lean();

      return token as IToken | null;
    } catch (error) {
      logger.debug('An error occurred while finding token:', error);
      throw error;
    }
  }

  // Return all methods
  return {
    findToken,
    createToken,
    replaceTokenIfCurrent,
    updateToken,
    deleteTokens,
  };
}

export type TokenMethods = ReturnType<typeof createTokenMethods>;
