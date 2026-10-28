import { logger } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import { brokerUserHeaders } from './headers';

/** The signed-in user's TensorGrid credit, read from the Tchat broker for the mobile sidebar. */
export interface TchatCredit {
  balance_cents: number;
  currency: string;
}

const TIMEOUT_MS = 5_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `null` when the broker is not configured, refuses, or answers something unusable. */
export async function getTchatCredit(
  req: { user?: Partial<IUser> },
  fetchImpl: FetchLike = fetch,
): Promise<TchatCredit | null> {
  const origin = (process.env.TCHAT_BROKER_ORIGIN ?? '').trim().replace(/\/+$/, '');
  const key = (process.env.TCHAT_BROKER_SHARED_KEY ?? '').trim();
  if (!origin || !key) {
    return null;
  }
  try {
    const response = await fetchImpl(`${origin}/tchat/credit`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...brokerUserHeaders(req, process.env.TCHAT_BROKER_BASE_URL),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`broker answered ${response.status}`);
    }
    const { balance_cents, currency } = (await response.json()) ?? {};
    if (typeof balance_cents !== 'number' || typeof currency !== 'string') {
      throw new Error('broker answered an unexpected shape');
    }
    return { balance_cents, currency };
  } catch (error) {
    logger.warn(`[tchat] credit unavailable: ${(error as Error)?.message ?? error}`);
    return null;
  }
}
