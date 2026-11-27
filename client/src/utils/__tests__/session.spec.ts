import { setTokenHeader } from 'librechat-data-provider';
import { getSessionPrincipal } from '../session';

/** Shaped like the real access token, whose payload carries an `id` claim. */
const jwtWith = (claims: Record<string, unknown>) =>
  `header.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.signature`;

/** A LibreChat access token, whose payload carries `id`. */
const tokenFor = (userId: string, issuedAt = 1) => jwtWith({ id: userId, iat: issuedAt });

/** An OpenID `id_token`, which names its subject as `sub` under an issuer. */
const openIdTokenFor = (subject: string, issuer = 'https://idp.example.com') =>
  jwtWith({ sub: subject, iss: issuer });

describe('getSessionPrincipal', () => {
  afterEach(() => {
    setTokenHeader(undefined);
  });

  it('reads the account from the installed credentials', () => {
    setTokenHeader(tokenFor('user-a'));
    expect(getSessionPrincipal()).toBe('user:user-a');
  });

  /* `setUserContext` installs the header in one synchronous call while React
   * state catches up later, so this has to change with the header, not after. */
  it('changes in the same turn as the header', () => {
    setTokenHeader(tokenFor('user-a'));
    setTokenHeader(tokenFor('user-b'));
    expect(getSessionPrincipal()).toBe('user:user-b');
  });

  it('reports no account once signed out', () => {
    setTokenHeader(tokenFor('user-a'));
    setTokenHeader(undefined);
    expect(getSessionPrincipal()).toBeUndefined();
  });

  /* A silent refresh rotates the token for the same account. Comparing tokens
   * would read that as a different session and throw away queued work the user
   * is still entitled to, so the claim is what matters. */
  it('sees a refreshed token as the same account', () => {
    setTokenHeader(tokenFor('user-a', 1));
    const before = getSessionPrincipal();
    setTokenHeader(tokenFor('user-a', 2));

    expect(getSessionPrincipal()).toBe(before);
    expect(getSessionPrincipal()).toBe('user:user-a');
  });

  /* With OpenID token reuse the bearer is the provider's own id_token, which
   * has no LibreChat `id`. Reading those as "nobody" would make two different
   * accounts compare equal, which is exactly how a queued write reaches the
   * wrong one. */
  it('identifies an OpenID session by its subject and issuer', () => {
    setTokenHeader(openIdTokenFor('subject-a'));
    expect(getSessionPrincipal()).toBe('oidc:https://idp.example.com:subject-a');
  });

  it('keeps two OpenID accounts distinct', () => {
    setTokenHeader(openIdTokenFor('subject-a'));
    const first = getSessionPrincipal();
    setTokenHeader(openIdTokenFor('subject-b'));

    expect(getSessionPrincipal()).not.toBe(first);
    expect(getSessionPrincipal()).toBeDefined();
  });

  it('keeps the same subject from different issuers distinct', () => {
    setTokenHeader(openIdTokenFor('shared', 'https://one.example.com'));
    const first = getSessionPrincipal();
    setTokenHeader(openIdTokenFor('shared', 'https://two.example.com'));

    expect(getSessionPrincipal()).not.toBe(first);
  });

  /* An opaque token names no one, so the credential itself has to separate the
   * sessions rather than both reading as nobody. */
  it('keeps two opaque sessions distinct', () => {
    setTokenHeader('opaque-token-a');
    const first = getSessionPrincipal();
    setTokenHeader('opaque-token-b');

    expect(first).toBeDefined();
    expect(getSessionPrincipal()).not.toBe(first);
  });

  it('falls back to the credential when the payload carries no subject', () => {
    setTokenHeader(jwtWith({ email: 'a@example.com' }));
    expect(getSessionPrincipal()).toBeDefined();
    expect(getSessionPrincipal()).not.toBe('user:undefined');
  });

  it('decodes a payload whose length needs base64 padding restored', () => {
    /* Ids vary in length, so the dropped `=` padding has to be put back. */
    for (const id of ['a', 'ab', 'abc', 'abcd', '6a89f66dd0b2baf4d4b02917']) {
      setTokenHeader(tokenFor(id));
      expect(getSessionPrincipal()).toBe(`user:${id}`);
    }
  });
});
