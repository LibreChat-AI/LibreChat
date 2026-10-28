import { BrokerError, noIdentity, unauthorized, upstreamUnavailable } from './errors.js';
import { invalidateToken, resolveToken } from './tokens.js';
import { resolveSubject } from './identity.js';
import { secretsMatch } from './signing.js';
import { TINYFISH_PREFIX, createTinyfish } from './tinyfish.js';
import { CATALOG_PREFIX, createCatalog } from './catalog.js';
import { CREDIT_PATH, createCredit } from './credit.js';

/** Paths the chat app is allowed to reach. Everything else is refused here
 *  rather than forwarded, so the broker can never be used as an open relay.
 *  The two image paths serve the `image_gen_oai` agent toolkit, whose edit
 *  half posts multipart/form-data rather than JSON. */
const RELAY_PREFIXES = [
  '/v1/chat/completions',
  /** LibreChat switches a turn to the Responses API whenever web search is on,
   *  whatever the model — so leaving this out made every such turn fail with a
   *  broker 404 that reads as "model unavailable". The Gateway serves the path
   *  natively. Prefix matching also covers `/v1/responses/compact` and the
   *  per-response `/v1/responses/{id}` reads. */
  '/v1/responses',
  '/v1/messages',
  '/v1/models',
  '/v1/embeddings',
  '/v1/images/generations',
  '/v1/images/edits',
  /** Google's own protocol, which the Gateway relays natively
   *  (`/v1beta/models/{model}:{action}`). The built-in Gemini image tool speaks
   *  it directly, so image generation there needs no OpenAI-shaped conversion. */
  '/v1beta/models',
];

/** Hop-by-hop and broker-private headers that must not reach the Gateway. */
const STRIPPED = new Set([
  'authorization',
  'x-api-key',
  /** The Google SDK sends the ingress key here as well as in Authorization;
   *  forwarding it would hand the shared key to the Gateway and to Google. */
  'x-goog-api-key',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
]);

const ingressKey = (headers) => {
  const bearer = headers.get('authorization') ?? '';
  if (bearer.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim();
  }
  // The Anthropic SDK authenticates with x-api-key, so `provider: anthropic`
  // custom endpoints arrive this way rather than as a bearer token.
  return (headers.get('x-api-key') ?? '').trim();
};

const identityOf = (headers) => ({
  email: (headers.get('x-tchat-user-email') ?? '').trim(),
  openidSub: (headers.get('x-tchat-user-openid') ?? '').trim(),
  userId: (headers.get('x-tchat-user-id') ?? '').trim(),
});

const forwardedHeaders = (headers, token) => {
  const result = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (STRIPPED.has(lower) || lower.startsWith('x-tchat-')) {
      continue;
    }
    result.set(name, value);
  }
  result.set('Authorization', `Bearer ${token}`);
  return result;
};

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const createApp = ({ config, cache, fetchImpl = fetch, logger = console }) => {
  const tinyfish = createTinyfish({ config, fetchImpl });
  const catalog = createCatalog({ config, cache, fetchImpl });
  const credit = createCredit({ config, cache, fetchImpl });

  const relay = async (request, url, token, bodyBytes) => {
    const upstream = new URL(url.pathname + url.search, config.upstreamBaseUrl);
    return fetchImpl(upstream, {
      method: request.method,
      headers: forwardedHeaders(request.headers, token),
      body: bodyBytes ?? undefined,
      redirect: 'manual',
    });
  };

  return async (request) => {
    const url = new URL(request.url, 'http://broker.internal');

    if (url.pathname === '/healthz') {
      // Lowercase, matching the /healthz convention used by tchat-proxy and
      // every TensorGrid stack service (readyz-style endpoints stay uppercase).
      return new Response('ok', { status: 200 });
    }

    try {
      if (!secretsMatch(ingressKey(request.headers), config.sharedKey)) {
        throw unauthorized();
      }
      // Web search and fetch bill to Tchat's own TinyFish key, not to the
      // user, so they need no identity and never touch the Gateway.
      if (url.pathname.startsWith(TINYFISH_PREFIX)) {
        return await tinyfish(request, url);
      }
      // Public TensorGrid catalog facts (which models are free) for the model
      // picker. Same for every user, so it needs no identity either.
      if (url.pathname.startsWith(CATALOG_PREFIX)) {
        return await catalog(request, url);
      }
      if (url.pathname === CREDIT_PATH) {
        return await credit(request, url);
      }
      if (!RELAY_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
        throw new BrokerError({
          status: 404,
          code: 'unsupported_path',
          message: `The TensorGrid broker does not relay ${url.pathname}.`,
        });
      }

      const identity = identityOf(request.headers);
      if (!identity.email && !identity.openidSub) {
        throw noIdentity();
      }

      const subject = await resolveSubject({ config, cache, fetchImpl, ...identity });
      // Buffered so a token refresh can replay it; chat payloads are small and
      // the streaming that matters is the response, which is piped through.
      const bodyBytes =
        request.method === 'GET' || request.method === 'HEAD'
          ? null
          : Buffer.from(await request.arrayBuffer());

      let token = await resolveToken({ config, cache, fetchImpl, subject });
      let response = await relay(request, url, token, bodyBytes);

      if (response.status === 401) {
        // The cached token was revoked or expired underneath us. Mint a fresh
        // one once; a second 401 is a real authorization failure worth showing.
        await invalidateToken({ cache, subject });
        token = await resolveToken({ config, cache, fetchImpl, subject, forceRefresh: true });
        response = await relay(request, url, token, bodyBytes);
      }

      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (error instanceof BrokerError) {
        if (error.status >= 500) {
          logger.error(`tchat-broker: ${error.code}: ${error.message}`);
        }
        return jsonResponse(error.status, error.body());
      }
      logger.error(`tchat-broker: unhandled ${error?.stack ?? error}`);
      return jsonResponse(503, upstreamUnavailable('unexpected broker failure').body());
    }
  };
};
