import type { Request } from 'express';

/** Only the router-verified trigger identity exempts the shared delivery transport from IP bans. */
export function getBanIp(
  req: Pick<Request, 'ip'> & { _isAgentTrigger?: boolean },
): string | undefined {
  return req._isAgentTrigger === true ? undefined : req.ip;
}
