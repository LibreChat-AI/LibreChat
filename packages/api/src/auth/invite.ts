import { Types } from 'mongoose';
import { logger, hashToken, getRandomValues } from '@librechat/data-schemas';

export interface InviteDeps {
  createToken: (data: {
    userId: Types.ObjectId;
    email: string;
    token: string;
    createdAt: number;
    expiresIn: number;
  }) => Promise<unknown>;
  findToken: (filter: { token: string; email: string }) => Promise<unknown>;
}

/** Creates a new user invite and returns the encoded token. */
export async function createInvite(
  email: string,
  deps: InviteDeps,
): Promise<string | { message: string }> {
  try {
    const token = await getRandomValues(32);
    const hash = await hashToken(token);
    const encodedToken = encodeURIComponent(token);
    const fakeUserId = new Types.ObjectId();

    await deps.createToken({
      userId: fakeUserId,
      email,
      token: hash,
      createdAt: Date.now(),
      expiresIn: 604800,
    });

    return encodedToken;
  } catch (error) {
    logger.error('[createInvite] Error creating invite', error);
    return { message: 'Error creating invite' };
  }
}

/** Retrieves and validates a user invite by encoded token and email. */
export async function getInvite(
  encodedToken: string,
  email: string,
  deps: InviteDeps,
): Promise<unknown> {
  try {
    /** `findToken` builds its query from the fields it is given, so an absent email
     * is a lookup by token alone — which would match the invite and let the caller
     * consume it without ever proving the address. */
    if (!email) {
      throw new Error('Invite not found or email does not match');
    }

    const token = decodeURIComponent(encodedToken);
    const hash = await hashToken(token);
    const invite = await deps.findToken({ token: hash, email });

    if (!invite) {
      throw new Error('Invite not found or email does not match');
    }

    return invite;
  } catch (error) {
    logger.error('[getInvite] Error getting invite:', error);
    return { error: true, message: (error as Error).message };
  }
}
