import jwt from 'jsonwebtoken';

export const AGENT_TRIGGER_SCOPE = 'agent_trigger';

type AgentTriggerRequest = {
  headers?: Record<string, string | string[] | undefined>;
  _isAgentTrigger?: boolean;
};

/**
 * Generate a short-lived JWT token.
 * @param {String} userId - The ID of the user.
 * @param {String} [expireIn='5m'] - The expiration time for the token.
 * @returns {String} - The generated JWT token.
 */
export const generateShortLivedToken = (userId: string, expireIn: string = '5m'): string => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET!, {
    expiresIn: expireIn,
    algorithm: 'HS256',
  });
};

/** Mint the server-only identity used by durable agent trigger admission. */
export const generateAgentTriggerToken = (userId: string, expireIn: string = '60s'): string => {
  return jwt.sign({ id: userId, scope: AGENT_TRIGGER_SCOPE }, process.env.JWT_SECRET!, {
    expiresIn: expireIn,
    algorithm: 'HS256',
  });
};

/** Verify the signed trigger scope together with its explicit transport marker. */
export const isAgentTriggerRequest = (req?: AgentTriggerRequest): boolean => {
  if (req?.headers?.['x-lc-agent-trigger'] !== '1') {
    return false;
  }
  const auth = req.headers.authorization;
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (token == null) {
    return false;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] });
    return typeof payload === 'object' && payload.scope === AGENT_TRIGGER_SCOPE;
  } catch {
    return false;
  }
};

/** Skip the shared loopback IP bucket while retaining per-user and concurrency limits. */
export const exemptAgentTriggerFromIpLimiter = (req?: AgentTriggerRequest): boolean =>
  typeof req?._isAgentTrigger === 'boolean' ? req._isAgentTrigger : isAgentTriggerRequest(req);
