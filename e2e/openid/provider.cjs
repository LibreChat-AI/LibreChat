/** Local-only OIDC provider and second application for session-check tests. Never deploy this fixture. */
const http = require('node:http');
const https = require('node:https');
const { generateKeyPairSync, randomBytes, createHash, sign } = require('node:crypto');
const { once } = require('node:events');

async function startProvider({ port = 0, appUrl = 'http://localhost:3080', tls } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const codes = new Map();
  const refreshTokens = new Map();
  const accessTokens = new Map();
  const sessions = new Map();
  const random = () => randomBytes(32).toString('base64url');
  let issuer;
  let failure;
  let tokenFault;
  const counters = { grants: 0, refreshes: 0 };
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const redirect = (res, url) => {
    res.writeHead(302, { Location: url });
    res.end();
  };
  const html = (res, body) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(body);
  };
  const claims = (subject) => ({
    sub: subject,
    email: `${subject.toLowerCase()}@example.test`,
    email_verified: true,
    name: `Account ${subject}`,
  });
  const jwt = (subject, audience, nonce) => {
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }),
    ).toString('base64url');
    const tokenClaims = {
      ...claims(subject),
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 3600,
      ...(nonce ? { nonce } : {}),
    };
    if (tokenFault === 'issuer') tokenClaims.iss = 'https://wrong-issuer.test';
    if (tokenFault === 'audience') tokenClaims.aud = 'wrong-client';
    if (tokenFault === 'expiry') tokenClaims.exp = now - 3600;
    const body = Buffer.from(JSON.stringify(tokenClaims)).toString('base64url');
    const payload = `${head}.${body}`;
    const signature = sign('RSA-SHA256', Buffer.from(payload), privateKey);
    if (tokenFault === 'signature') signature[0] ^= 1;
    return `${payload}.${signature.toString('base64url')}`;
  };
  const handler = async (req, res) => {
    const url = new URL(req.url, issuer);
    const browserSession = /(?:^|;\s*)oidc_test_session=([^;]+)/.exec(
      req.headers.cookie ?? '',
    )?.[1];
    const subject = sessions.get(browserSession);
    if (url.pathname === '/.well-known/openid-configuration')
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (url.pathname === '/userinfo') {
      const user = accessTokens.get(req.headers.authorization?.replace(/^Bearer /, ''));
      return user ? json(res, 200, claims(user)) : json(res, 401, { error: 'invalid_token' });
    }
    if (url.pathname === '/test/failure') {
      failure = url.searchParams.get('error') || undefined;
      return redirect(res, `${issuer}/console`);
    }
    if (url.pathname === '/console')
      return html(
        res,
        `<h1>Test Console</h1><p>Provider account: ${subject ?? 'signed out'}</p><a href="/console/login?account=A">Sign in as A</a> <a href="/console/login?account=B">Sign in as B</a> <a href="/logout">Sign out</a> <a href="${appUrl}">Open LibreChat</a>`,
      );
    if (url.pathname === '/console/login') {
      const authorization = new URL(`${issuer}/authorize`);
      authorization.search = new URLSearchParams({
        client_id: 'console-test',
        redirect_uri: `${issuer}/console/callback`,
        response_type: 'code',
        scope: 'openid',
        state: random(),
        nonce: random(),
      }).toString();
      return redirect(
        res,
        `${issuer}/login?account=${url.searchParams.get('account') === 'B' ? 'B' : 'A'}&return=${encodeURIComponent(authorization.pathname + authorization.search)}`,
      );
    }
    if (url.pathname === '/console/callback') {
      const code = url.searchParams.get('code');
      const grant = codes.get(code);
      if (!grant || grant.client !== 'console-test')
        return json(res, 400, { error: 'invalid_grant' });
      codes.delete(code);
      res.setHeader(
        'Set-Cookie',
        `console_test_account=${grant.subject}; HttpOnly; SameSite=Lax; Path=/console`,
      );
      return redirect(res, `${issuer}/console`);
    }
    if (url.pathname === '/logout') {
      sessions.delete(browserSession);
      res.setHeader('Set-Cookie', 'oidc_test_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/');
      return redirect(res, `${issuer}/console`);
    }
    if (url.pathname === '/login') {
      const target = url.searchParams.get('return');
      const safeTarget =
        typeof target === 'string' && target.startsWith('/authorize?') ? target : '/console';
      const account = url.searchParams.get('account');
      if (account === 'A' || account === 'B') {
        const sessionId = random();
        sessions.set(sessionId, account);
        res.setHeader(
          'Set-Cookie',
          `oidc_test_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/`,
        );
        return redirect(res, safeTarget);
      }
      return html(
        res,
        `<h1>Test identity provider</h1><a href="/login?account=A&return=${encodeURIComponent(safeTarget)}">Sign in as A</a> <a href="/login?account=B&return=${encodeURIComponent(safeTarget)}">Sign in as B</a>`,
      );
    }
    if (url.pathname === '/authorize') {
      const client = url.searchParams.get('client_id');
      const callback = url.searchParams.get('redirect_uri');
      if (
        (client === 'librechat-test' && callback !== `${appUrl}/oauth/openid/callback`) ||
        (client === 'console-test' && callback !== `${issuer}/console/callback`) ||
        !['librechat-test', 'console-test'].includes(client)
      )
        return json(res, 400, { error: 'invalid_request' });
      const destination = new URL(callback);
      destination.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (url.searchParams.get('prompt') === 'none' && (failure || !subject)) {
        destination.searchParams.set('error', failure ?? 'login_required');
        return redirect(res, destination.href);
      }
      if (!subject)
        return redirect(
          res,
          `${issuer}/login?return=${encodeURIComponent(url.pathname + url.search)}`,
        );
      const code = random();
      codes.set(code, {
        client,
        callback,
        subject,
        nonce: url.searchParams.get('nonce'),
        challenge: url.searchParams.get('code_challenge'),
      });
      destination.searchParams.set('code', code);
      return redirect(res, destination.href);
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')
        : [];
      const client = basic[0] || body.get('client_id');
      if (
        client !== 'librechat-test' ||
        (basic[1] || body.get('client_secret')) !== 'local-test-secret'
      )
        return json(res, 401, { error: 'invalid_client' });
      let grant;
      if (body.get('grant_type') === 'refresh_token') {
        grant = refreshTokens.get(body.get('refresh_token'));
        counters.refreshes++;
      } else {
        grant = codes.get(body.get('code'));
        codes.delete(body.get('code'));
        counters.grants++;
        if (
          grant?.callback !== body.get('redirect_uri') ||
          (grant?.challenge &&
            createHash('sha256')
              .update(body.get('code_verifier') ?? '')
              .digest('base64url') !== grant.challenge)
        )
          grant = undefined;
      }
      if (!grant || grant.client !== client) return json(res, 400, { error: 'invalid_grant' });
      const access = random();
      const refresh = random();
      accessTokens.set(access, grant.subject);
      refreshTokens.set(refresh, grant);
      return json(res, 200, {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: jwt(grant.subject, client, grant.nonce),
      });
    }
    json(res, 404, { error: 'not_found' });
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  issuer = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  return {
    issuer,
    counters,
    setTokenFault: (value) => {
      tokenFault = value;
    },
    setFailure: (value) => {
      failure = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
module.exports = { startProvider };
if (require.main === module)
  startProvider({
    port: Number(process.env.OIDC_TEST_PORT || 4400),
    appUrl: process.env.OIDC_TEST_APP_URL || 'http://localhost:3080',
  }).then(({ issuer }) => console.log(`Test Console: ${issuer}/console\nOPENID_ISSUER=${issuer}`));
