import type { IToken } from '~/types';

/** A user holds a handful of tokens of one type at most; the bound keeps a read cheap regardless. */
const MAX_TOKENS_OF_USER = 100;

export interface TokenListMethods {
  /** The unexpired tokens of one type a user holds, such as one per connected provider host,
   *  newest first and at most a hundred. */
  findTokensOfUser(query: { userId: string; type: string }): Promise<IToken[]>;
}

export function createTokenListMethods(mongoose: typeof import('mongoose')): TokenListMethods {
  async function findTokensOfUser(query: { userId: string; type: string }): Promise<IToken[]> {
    const Token = mongoose.models.Token;
    /** Unexpired rows, the most recently written first: a grant in use is rewritten as it is
     *  used, so it is never the row the bound leaves out. */
    return Token.find({ userId: query.userId, type: query.type, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .limit(MAX_TOKENS_OF_USER)
      .lean<IToken[]>();
  }
  return { findTokensOfUser };
}
