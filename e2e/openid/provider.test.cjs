const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { startProvider } = require('./provider.cjs');
const client = createRequire(path.resolve(__dirname, '../../api/package.json'))('openid-client');
const { createOpenIDCheckProvider } = require('@librechat/api');

test('real OIDC grants distinguish SSO logout/account changes while old refresh remains valid', async () => {
  const fixture = await startProvider();
  try {
    const config = await client.discovery(
      new URL(fixture.issuer),
      'librechat-test',
      'local-test-secret',
      undefined,
      { execute: [client.allowInsecureRequests] },
    );
    const provider = createOpenIDCheckProvider(
      client,
      () => config,
      'http://localhost:3080/oauth/openid/callback',
    );
    const proof = () => ({
      state: client.randomState(),
      verifier: client.randomPKCECodeVerifier(),
      nonce: client.randomNonce(),
    });
    const login = async (account) => {
      const response = await fetch(`${fixture.issuer}/login?account=${account}`, {
        redirect: 'manual',
      });
      return response.headers.get('set-cookie').split(';')[0];
    };
    const authorize = async (cookie, challenge, authorization) => {
      const response = await fetch(authorization || (await provider.authorize(challenge)), {
        headers: cookie ? { Cookie: cookie } : {},
        redirect: 'manual',
      });
      return new URL(response.headers.get('location'));
    };
    const parameters = new URL(await provider.authorize(proof())).searchParams;
    assert.equal(parameters.get('scope'), 'openid');
    assert.equal(parameters.get('prompt'), 'none');
    for (const name of ['audience', 'resource', 'login_hint', 'id_token_hint'])
      assert.equal(parameters.has(name), false);
    const cookie = await login('A');
    const first = proof();
    const initialTokens = await client.authorizationCodeGrant(
      config,
      await authorize(cookie, first),
      {
        pkceCodeVerifier: first.verifier,
        expectedState: first.state,
        expectedNonce: first.nonce,
        idTokenExpected: true,
      },
    );
    for (let i = 0; i < 2; i++) {
      const p = proof();
      assert.deepEqual(await provider.verify(await authorize(cookie, p), p), {
        status: 'verified',
        identity: { iss: fixture.issuer, sub: 'A' },
      });
    }
    await fetch(`${fixture.issuer}/logout`, { headers: { Cookie: cookie }, redirect: 'manual' });
    const loggedOut = proof();
    assert.deepEqual(await provider.verify(await authorize(cookie, loggedOut), loggedOut), {
      status: 'login_required',
    });
    const refreshed = await client.refreshTokenGrant(config, initialTokens.refresh_token);
    assert.equal(refreshed.claims().sub, 'A');
    const cookieB = await login('B');
    const switched = proof();
    assert.equal(
      (await provider.verify(await authorize(cookieB, switched), switched)).identity.sub,
      'B',
    );
    for (const error of [
      'interaction_required',
      'consent_required',
      'account_selection_required',
    ]) {
      fixture.setFailure(error);
      const p = proof();
      assert.deepEqual(await provider.verify(await authorize(cookieB, p), p), {
        status: 'interaction_required',
      });
    }
    fixture.setFailure(undefined);
    for (const fault of ['signature', 'issuer', 'audience', 'expiry']) {
      fixture.setTokenFault(fault);
      const p = proof();
      await assert.rejects(provider.verify(await authorize(cookieB, p), p));
    }
    fixture.setTokenFault(undefined);
    fixture.setFailure('login_required');
    const errorState = proof();
    await assert.rejects(
      provider.verify(await authorize(cookieB, errorState), { ...errorState, state: 'wrong' }),
    );
    fixture.setFailure(undefined);
    const invalid = proof();
    await assert.rejects(
      provider.verify(await authorize(cookieB, invalid), { ...invalid, nonce: 'wrong' }),
    );
    const wrongState = proof();
    await assert.rejects(
      provider.verify(await authorize(cookieB, wrongState), { ...wrongState, state: 'wrong' }),
    );
    const wrongPkce = proof();
    await assert.rejects(
      provider.verify(await authorize(cookieB, wrongPkce), { ...wrongPkce, verifier: 'wrong' }),
    );
  } finally {
    await fixture.close();
  }
});
