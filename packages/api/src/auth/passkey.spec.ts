import Keyv from 'keyv';
import { logger } from '@librechat/data-schemas';
import { MAX_PASSKEYS_PER_USER } from 'librechat-data-provider';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { TCustomConfig } from 'librechat-data-provider';
import type { PasskeyChallengeStore, PasskeyConfig } from './passkey';
import {
  authenticationChallengeKey,
  consumeChallenge,
  createPasskeyAuthenticationOptions,
  createPasskeyRegistrationOptions,
  defaultPasskeyName,
  getPasskeyConfig,
  isPasskeyEnabled,
  registrationChallengeKey,
  resolveMaxPasskeysPerUser,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from './passkey';

/** In-memory stand-in for the app's Keyv challenge store. */
function createStore(): PasskeyChallengeStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key) => entries.get(key),
    set: async (key, value) => entries.set(key, value),
    delete: async (key) => entries.delete(key),
    getDel: async (key) => {
      const value = entries.get(key);
      entries.delete(key);
      return value;
    },
  };
}

const config: PasskeyConfig = {
  enabled: true,
  rpID: 'chat.example.com',
  rpName: 'LibreChat',
  origins: ['https://chat.example.com'],
};

const user = { id: '65f0000000000000000000aa', email: 'user@example.com', name: 'Ada' };

/** Authenticator data flags: user present, user present plus user verified, and backup eligible plus backed up. */
const FLAG_UP = 0x01;
const FLAG_UP_UV = 0x05;
const FLAG_BE_BS = 0x18;

/**
 * Builds a real ES256 authenticator so assertions are genuinely signed and the
 * only thing under test is which flags the server insists on.
 */
function createAuthenticator(credentialId = 'cred-id') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x = '', y = '' } = publicKey.export({ format: 'jwk' });

  /** COSE_Key map: kty EC2, alg ES256, crv P-256, then the 32-byte x and y. */
  const cosePublicKey = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(y, 'base64url'),
  ]);

  const id = Buffer.from(credentialId, 'utf8').toString('base64url');

  const assert = ({
    challenge,
    flags,
    counter = 1,
    origin = config.origins[0],
  }: {
    challenge: string;
    flags: number;
    counter?: number;
    origin?: string;
  }): AuthenticationResponseJSON => {
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
      'utf8',
    );

    const authenticatorData = Buffer.alloc(37);
    createHash('sha256').update(config.rpID).digest().copy(authenticatorData, 0);
    authenticatorData[32] = flags;
    authenticatorData.writeUInt32BE(counter, 33);

    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]),
      privateKey,
    );

    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    } as AuthenticationResponseJSON;
  };

  return { assert, credential: { credentialId: id, publicKey: cosePublicKey, counter: 0 } };
}

describe('resolveMaxPasskeysPerUser', () => {
  it('prefers the yaml value over the environment and the documented default', () => {
    expect(
      resolveMaxPasskeysPerUser({ perUserMax: 5 }, {
        MAX_PASSKEYS_PER_USER: '9',
      } as NodeJS.ProcessEnv),
    ).toBe(5);
  });

  it('falls back to the environment, then the documented default', () => {
    expect(
      resolveMaxPasskeysPerUser(undefined, { MAX_PASSKEYS_PER_USER: '9' } as NodeJS.ProcessEnv),
    ).toBe(9);
    expect(resolveMaxPasskeysPerUser(undefined, {} as NodeJS.ProcessEnv)).toBe(
      MAX_PASSKEYS_PER_USER,
    );
    expect(
      resolveMaxPasskeysPerUser(undefined, {
        MAX_PASSKEYS_PER_USER: 'not-a-number',
      } as NodeJS.ProcessEnv),
    ).toBe(MAX_PASSKEYS_PER_USER);
  });

  it('applies the schema bounds to the environment value too', () => {
    const rejected = ['0', '-1', '101', '9abc', '1.5'];
    for (const value of rejected) {
      expect(
        resolveMaxPasskeysPerUser(undefined, { MAX_PASSKEYS_PER_USER: value } as NodeJS.ProcessEnv),
      ).toBe(MAX_PASSKEYS_PER_USER);
    }
    expect(
      resolveMaxPasskeysPerUser(undefined, { MAX_PASSKEYS_PER_USER: '100' } as NodeJS.ProcessEnv),
    ).toBe(100);
  });

  it('ignores an out-of-bounds cap from an unvalidated override', () => {
    const env = { MAX_PASSKEYS_PER_USER: '9' } as NodeJS.ProcessEnv;
    const rejected: unknown[] = [0, -1, 101, 1.5, '5', 'abc', null];
    for (const perUserMax of rejected) {
      expect(resolveMaxPasskeysPerUser({ perUserMax } as TCustomConfig['passkeys'], env)).toBe(9);
    }
  });
});

describe('getPasskeyConfig', () => {
  it('derives the RP ID and origins from DOMAIN_CLIENT', () => {
    const resolved = getPasskeyConfig({
      ALLOW_PASSKEY_LOGIN: 'true',
      DOMAIN_CLIENT: 'https://chat.example.com',
      DOMAIN_SERVER: 'https://chat.example.com',
      APP_TITLE: 'Acme Chat',
    } as NodeJS.ProcessEnv);

    expect(resolved.enabled).toBe(true);
    expect(resolved.rpID).toBe('chat.example.com');
    expect(resolved.rpName).toBe('Acme Chat');
    expect(resolved.origins).toEqual(['https://chat.example.com']);
  });

  it('keeps a distinct server origin alongside the client origin', () => {
    const resolved = getPasskeyConfig({
      ALLOW_PASSKEY_LOGIN: 'true',
      DOMAIN_CLIENT: 'https://chat.example.com',
      DOMAIN_SERVER: 'https://api.example.com',
    } as NodeJS.ProcessEnv);

    expect(resolved.origins).toEqual(['https://chat.example.com', 'https://api.example.com']);
  });

  it('prefers explicit overrides and ignores unparseable origins', () => {
    const resolved = getPasskeyConfig({
      ALLOW_PASSKEY_LOGIN: 'true',
      DOMAIN_CLIENT: 'https://chat.example.com',
      PASSKEY_RP_ID: 'example.com',
      PASSKEY_RP_NAME: 'Custom',
      PASSKEY_ORIGINS: 'https://a.example.com, not-a-url ,https://b.example.com',
    } as NodeJS.ProcessEnv);

    expect(resolved.rpID).toBe('example.com');
    expect(resolved.rpName).toBe('Custom');
    expect(resolved.origins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('is disabled unless ALLOW_PASSKEY_LOGIN is truthy', () => {
    const resolved = getPasskeyConfig({
      DOMAIN_CLIENT: 'https://chat.example.com',
    } as NodeJS.ProcessEnv);

    expect(resolved.enabled).toBe(false);
    expect(isPasskeyEnabled(resolved)).toBe(false);
  });

  it('reports disabled when no origin can be resolved', () => {
    expect(isPasskeyEnabled({ ...config, origins: [] })).toBe(false);
  });
});

describe('consumeChallenge', () => {
  it('returns the challenge once and invalidates it', async () => {
    const store = createStore();
    await store.set('key', 'challenge-value');

    expect(await consumeChallenge(store, 'key')).toBe('challenge-value');
    expect(await consumeChallenge(store, 'key')).toBeUndefined();
  });

  it('returns undefined for an unknown key', async () => {
    expect(await consumeChallenge(createStore(), 'missing')).toBeUndefined();
  });

  it('hands a challenge to only one of two concurrent readers without a native getDel', async () => {
    const keyv = new Keyv<string>();
    const store: PasskeyChallengeStore = {
      get: (key) => keyv.get(key),
      set: (key, value, ttl) => keyv.set(key, value, ttl),
      delete: (key) => keyv.delete(key),
    };
    await store.set('key', 'challenge-value');

    const results = await Promise.all([
      consumeChallenge(store, 'key'),
      consumeChallenge(store, 'key'),
    ]);

    expect(results.filter((value) => value === 'challenge-value')).toHaveLength(1);
    expect(results.filter((value) => value === undefined)).toHaveLength(1);
  });

  it('uses getDel when present so concurrent consumers cannot both win', async () => {
    const store = createStore();
    await store.set('key', 'challenge-value');

    const [first, second] = await Promise.all([
      consumeChallenge(store, 'key'),
      consumeChallenge(store, 'key'),
    ]);

    const values = [first, second].filter((value) => value !== undefined);
    expect(values).toEqual(['challenge-value']);
    expect(store.entries.has('key')).toBe(false);
  });

  it('falls back to get-then-delete when getDel is absent', async () => {
    const entries = new Map<string, string>([['key', 'challenge-value']]);
    const store: PasskeyChallengeStore = {
      get: async (key) => entries.get(key),
      set: async (key, value) => entries.set(key, value),
      delete: async (key) => entries.delete(key),
    };

    expect(await consumeChallenge(store, 'key')).toBe('challenge-value');
    expect(await consumeChallenge(store, 'key')).toBeUndefined();
    expect(entries.has('key')).toBe(false);
  });
});

describe('createPasskeyRegistrationOptions', () => {
  it('stores the challenge under the user and excludes known credentials', async () => {
    const store = createStore();
    const options = await createPasskeyRegistrationOptions({
      config,
      store,
      user,
      existingCredentials: [
        { credentialId: 'abc', publicKey: Buffer.alloc(1), counter: 0, transports: ['internal'] },
      ],
    });

    expect(options.rp).toEqual({ id: config.rpID, name: config.rpName });
    expect(options.user.name).toBe(user.email);
    expect(options.user.displayName).toBe('Ada');
    expect(options.excludeCredentials).toEqual([
      { id: 'abc', type: 'public-key', transports: ['internal'] },
    ]);
    /** Discoverable credentials are what make usernameless sign-in possible. */
    expect(options.authenticatorSelection?.residentKey).toBe('required');
    /** UV at registration so the credential is bound to a verified user gesture. */
    expect(options.authenticatorSelection?.userVerification).toBe('required');
    expect(store.entries.get(registrationChallengeKey(user.id))).toBe(options.challenge);
  });
});

describe('createPasskeyAuthenticationOptions', () => {
  it('omits allowCredentials so the response does not reveal account existence', async () => {
    const store = createStore();
    const { options, sessionId } = await createPasskeyAuthenticationOptions({ config, store });

    expect(options.allowCredentials).toBeUndefined();
    expect(options.rpId).toBe(config.rpID);
    expect(store.entries.get(authenticationChallengeKey(sessionId))).toBe(options.challenge);
  });

  it('asks the authenticator to verify the user, since sign-in is single-factor', async () => {
    const { options } = await createPasskeyAuthenticationOptions({ config, store: createStore() });

    expect(options.userVerification).toBe('required');
  });

  it('issues a distinct session handle per ceremony', async () => {
    const store = createStore();
    const first = await createPasskeyAuthenticationOptions({ config, store });
    const second = await createPasskeyAuthenticationOptions({ config, store });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(store.entries.size).toBe(2);
  });
});

describe('verification without a live challenge', () => {
  const registrationResponse = {
    id: 'cred-id',
    rawId: 'cred-id',
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: '', attestationObject: '' },
  } as RegistrationResponseJSON;

  const authenticationResponse = {
    id: 'cred-id',
    rawId: 'cred-id',
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: '', authenticatorData: '', signature: '' },
  } as AuthenticationResponseJSON;

  it('rejects a registration with no pending challenge', async () => {
    const result = await verifyPasskeyRegistration({
      config,
      store: createStore(),
      userId: user.id,
      response: registrationResponse,
    });

    expect(result).toBeNull();
  });

  it('rejects a replayed registration challenge', async () => {
    const store = createStore();
    await createPasskeyRegistrationOptions({ config, store, user });

    /** The first attempt consumes the challenge even though the payload is bogus. */
    expect(
      await verifyPasskeyRegistration({
        config,
        store,
        userId: user.id,
        response: registrationResponse,
      }),
    ).toBeNull();
    expect(store.entries.has(registrationChallengeKey(user.id))).toBe(false);
  });

  it('rejects an assertion with an unknown session handle', async () => {
    const result = await verifyPasskeyAuthentication({
      config,
      store: createStore(),
      sessionId: 'never-issued',
      response: authenticationResponse,
      credential: { credentialId: 'cred-id', publicKey: Buffer.alloc(1), counter: 0 },
    });

    expect(result).toBeNull();
  });

  it('rejects a tampered assertion and burns the challenge', async () => {
    const store = createStore();
    const { sessionId } = await createPasskeyAuthenticationOptions({ config, store });

    const result = await verifyPasskeyAuthentication({
      config,
      store,
      sessionId,
      response: authenticationResponse,
      credential: { credentialId: 'cred-id', publicKey: Buffer.alloc(1), counter: 0 },
    });

    expect(result).toBeNull();
    expect(store.entries.has(authenticationChallengeKey(sessionId))).toBe(false);
  });
});

describe('verifyPasskeyAuthentication', () => {
  it('accepts an assertion the authenticator user-verified', async () => {
    const store = createStore();
    const { assert, credential } = createAuthenticator();
    const { options, sessionId } = await createPasskeyAuthenticationOptions({ config, store });

    const result = await verifyPasskeyAuthentication({
      config,
      store,
      sessionId,
      response: assert({ challenge: options.challenge, flags: FLAG_UP_UV }),
      credential,
    });

    expect(result).toEqual({ newCounter: 1, backedUp: false });
  });

  it('reports the backup state the authenticator asserts', async () => {
    const store = createStore();
    const { assert, credential } = createAuthenticator();
    const { options, sessionId } = await createPasskeyAuthenticationOptions({ config, store });

    const result = await verifyPasskeyAuthentication({
      config,
      store,
      sessionId,
      response: assert({ challenge: options.challenge, flags: FLAG_UP_UV | FLAG_BE_BS }),
      credential,
    });

    expect(result).toEqual({ newCounter: 1, backedUp: true });
  });

  it('rejects an assertion carrying only the user-present flag', async () => {
    const store = createStore();
    const { assert, credential } = createAuthenticator();
    const { options, sessionId } = await createPasskeyAuthenticationOptions({ config, store });

    /** A tap on a PIN-less key is possession alone, which cannot stand in for a login. */
    const result = await verifyPasskeyAuthentication({
      config,
      store,
      sessionId,
      response: assert({ challenge: options.challenge, flags: FLAG_UP }),
      credential,
    });

    expect(result).toBeNull();
    expect(store.entries.has(authenticationChallengeKey(sessionId))).toBe(false);
  });
});

describe('ceremony failure logging', () => {
  const credential = { credentialId: 'cred-id', publicKey: Buffer.alloc(1), counter: 0 };

  /** Builds the base64url `clientDataJSON` an unauthenticated caller fully controls. */
  function clientDataJSON(type: string, challenge: string): string {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: config.origins[0], crossOrigin: false }),
      'utf8',
    ).toString('base64url');
  }

  function authenticationResponseWith(challenge: string): AuthenticationResponseJSON {
    return {
      id: 'cred-id',
      rawId: 'cred-id',
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON('webauthn.get', challenge),
        authenticatorData: '',
        signature: '',
      },
    } as AuthenticationResponseJSON;
  }

  function registrationResponseWith(challenge: string): RegistrationResponseJSON {
    return {
      id: 'cred-id',
      rawId: 'cred-id',
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON('webauthn.create', challenge),
        attestationObject: '',
      },
    } as RegistrationResponseJSON;
  }

  /** A challenge crafted to close the log line and forge a second, fake record. */
  const forgedChallenge =
    'x", expected "y\r\n2026-01-01 00:00:00 info: [FORGED] admin@example.com signed in\u001b[31m\u0007';

  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  it('logs the authentication failure as one line with no injected control characters', async () => {
    const store = createStore();
    const { sessionId } = await createPasskeyAuthenticationOptions({ config, store });

    const result = await verifyPasskeyAuthentication({
      config,
      store,
      sessionId,
      response: authenticationResponseWith(forgedChallenge),
      credential,
    });

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    /** A single string argument: nothing is left for winston to concatenate. */
    expect(warn.mock.calls[0]).toHaveLength(1);
    const line = warn.mock.calls[0][0] as string;
    expect(typeof line).toBe('string');
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\r\n\u0000-\u001f\u007f-\u009f]/);
    /** The forged text stays inline as diagnostics: it can never begin its own record. */
    expect(line.indexOf('[FORGED]')).toBeGreaterThan(0);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('keeps the reason for an authentication failure readable', async () => {
    const store = createStore();
    const { sessionId } = await createPasskeyAuthenticationOptions({ config, store });

    await verifyPasskeyAuthentication({
      config,
      store,
      sessionId,
      response: authenticationResponseWith('a-mismatched-challenge'),
      credential,
    });

    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('[passkey] Authentication verification failed');
    expect(line).toContain('Unexpected authentication response challenge');
    expect(line).toContain('a-mismatched-challenge');
  });

  it('logs the registration failure as one line with no injected control characters', async () => {
    const store = createStore();
    await createPasskeyRegistrationOptions({ config, store, user });

    const result = await verifyPasskeyRegistration({
      config,
      store,
      userId: user.id,
      response: registrationResponseWith(forgedChallenge),
    });

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);

    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('[passkey] Registration verification failed');
    expect(line).toContain('Unexpected registration response challenge');
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\r\n\u0000-\u001f\u007f-\u009f]/);
    /** The forged text stays inline as diagnostics: it can never begin its own record. */
    expect(line.indexOf('[FORGED]')).toBeGreaterThan(0);
  });

  it('bounds how much attacker-supplied text reaches the log', async () => {
    const store = createStore();
    const { sessionId } = await createPasskeyAuthenticationOptions({ config, store });

    await verifyPasskeyAuthentication({
      config,
      store,
      sessionId,
      response: authenticationResponseWith('A'.repeat(5000)),
      credential,
    });

    const line = warn.mock.calls[0][0] as string;
    expect(line).toMatch(/\.\.\. \[truncated\]$/);
    expect(line.length).toBeLessThan(300);
  });
});

describe('defaultPasskeyName', () => {
  it.each([
    [['hybrid'], 'Phone or tablet'],
    [['usb'], 'Security key'],
    [['nfc'], 'Security key'],
    [['internal'], 'This device'],
    [[], 'Passkey'],
  ])('labels %p as %s', (transports, expected) => {
    expect(defaultPasskeyName(transports)).toBe(expected);
  });
});
