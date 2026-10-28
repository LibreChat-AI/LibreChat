import { signedHeaders, canonicalJson } from './signing.js';
import { BrokerError, noAccount, noIdentity, upstreamUnavailable } from './errors.js';
import { request } from './identity.js';

/**
 * The signed-in user's current TensorGrid credit, for the Tchat-Mobile sidebar.
 * Identity comes from the `X-Tchat-User-*` headers like the inference relay;
 * only balance and currency leave Django.
 */
export const CREDIT_PATH = '/tchat/credit';

const DJANGO_PATH = '/api/internal/tchat/v1/credit';

/** Each read costs Django a Gateway round trip, and the app asks on every drawer open. */
const CACHE_SECONDS = 15;

export const createCredit = ({ config, cache, fetchImpl = fetch }) =>
  async (request_, url) => {
    if (url.pathname !== CREDIT_PATH || request_.method !== 'GET') {
      throw new BrokerError({
        status: 404,
        code: 'unsupported_path',
        message: `The TensorGrid broker does not serve ${url.pathname}.`,
      });
    }
    const email = (request_.headers.get('x-tchat-user-email') ?? '').trim();
    const openidSub = (request_.headers.get('x-tchat-user-openid') ?? '').trim();
    if (!email && !openidSub) {
      throw noIdentity();
    }

    const cacheKey = `tchat:credit:${openidSub || email.toLowerCase()}`;
    let data = await cache.get(cacheKey);
    if (!data) {
      const body = canonicalJson({ email, openid_sub: openidSub });
      const response = await request({
        fetchImpl,
        url: `${config.djangoBaseUrl}${DJANGO_PATH}`,
        method: 'POST',
        body,
        headers: signedHeaders({
          secret: config.tchatSecret,
          method: 'POST',
          target: DJANGO_PATH,
          body,
        }),
        timeoutMs: config.requestTimeoutMs,
      });
      if (response.status === 404) {
        throw noAccount();
      }
      if (!response.ok) {
        throw upstreamUnavailable(`credit lookup returned ${response.status}`);
      }
      const payload = (await response.json())?.data ?? {};
      data = { balance_cents: payload.balance_cents, currency: payload.currency };
      await cache.set(cacheKey, data, CACHE_SECONDS);
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  };
