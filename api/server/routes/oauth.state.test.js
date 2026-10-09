const express = require('express');
const request = require('supertest');
const passport = require('passport');
const cookieParser = require('cookie-parser');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/models', () => ({
  findUser: jest.fn(),
  updateUser: jest.fn(),
  findBalanceByUser: jest.fn(),
  upsertBalanceFields: jest.fn(),
}));

jest.mock('~/strategies/process', () => ({
  createSocialUser: jest.fn(),
  handleExistingUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('~/server/middleware', () => ({
  logHeaders: (req, res, next) => next(),
  loginLimiter: (req, res, next) => next(),
  markOAuthNavigation: (req, res, next) => next(),
  checkDomainAllowed: (req, res, next) => next(),
}));

jest.mock('~/server/controllers/auth/oauth', () => ({
  createOAuthHandler: () => (req, res) => res.status(200).json({ userId: req.user._id }),
}));

const ORIGINAL_ENV = process.env;
const APP_URL = 'https://chat.example.com';

/** Splits a `Set-Cookie` header into its name, value and lower-cased attributes. */
function parseSetCookie(header) {
  const [pair, ...attributes] = header.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  return {
    name: pair.slice(0, separator),
    value: decodeURIComponent(pair.slice(separator + 1)),
    attributes: attributes.map((attribute) => attribute.toLowerCase()),
  };
}

function getStateCookie(response, provider) {
  const headers = response.headers['set-cookie'] ?? [];
  return headers
    .map(parseSetCookie)
    .find(({ name }) => name.startsWith(`__Host-oauth_state_${provider}.`));
}

/** The `name=value` pair a browser sends back for a cookie the server set. */
const asCookie = ({ name, value }) => `${name}=${value}`;

const stateLocation = (response) => new URL(response.headers.location).searchParams.get('state');
const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;

describe('OAuth login state binding', () => {
  let app;
  let github;
  let apple;
  let findUser;

  beforeAll(() => {
    process.env = {
      ...ORIGINAL_ENV,
      DOMAIN_CLIENT: APP_URL,
      DOMAIN_SERVER: APP_URL,
      GITHUB_CLIENT_ID: 'github-client',
      GITHUB_CLIENT_SECRET: 'github-secret',
      GITHUB_CALLBACK_URL: '/oauth/github/callback',
      APPLE_CLIENT_ID: 'apple-client',
      APPLE_TEAM_ID: 'apple-team',
      APPLE_KEY_ID: 'apple-key',
      APPLE_PRIVATE_KEY_PATH: '/nonexistent/apple.p8',
      APPLE_CALLBACK_URL: '/oauth/apple/callback',
    };

    const githubStrategy = require('~/strategies/githubStrategy');
    const appleStrategy = require('~/strategies/appleStrategy');
    ({ findUser } = require('~/models'));

    const stateOptions = { secret: 'jwt-secret', secureCookie: true };
    github = githubStrategy(stateOptions);
    apple = appleStrategy(stateOptions);
    passport.use(github);
    passport.use(apple);

    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());
    app.use(passport.initialize());
    app.use('/oauth', require('./oauth'));
    app.use((err, req, res, _next) => res.status(500).json({ message: err.message }));
  });

  afterAll(() => {
    passport.unuse('github');
    passport.unuse('apple');
    process.env = ORIGINAL_ENV;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    github._oauth2.getOAuthAccessToken = jest.fn((code, params, callback) =>
      callback(null, 'provider-access-token', 'provider-refresh-token', {}),
    );
    github.userProfile = jest.fn((accessToken, done) =>
      done(null, {
        id: '42',
        username: 'user',
        displayName: 'User',
        emails: [{ value: 'user@example.com', verified: true }],
        photos: [{ value: 'https://avatars.example.com/42' }],
      }),
    );
    apple._oauth2.getOAuthAccessToken = jest.fn((code, params, callback) =>
      callback(new Error('token exchange reached')),
    );
    findUser.mockResolvedValue({
      _id: 'user-1',
      provider: 'github',
      githubId: '42',
      email: 'user@example.com',
    });
  });

  describe('GitHub', () => {
    it('signs the authorization state for a host-only binding cookie', async () => {
      const response = await request(app).get('/oauth/github').expect(302);

      const location = new URL(response.headers.location);
      const cookie = getStateCookie(response, 'github');

      expect(location.origin).toBe('https://github.com');
      expect(location.searchParams.get('state')).toBeTruthy();
      expect(cookie.value).toMatch(BINDING_PATTERN);
      expect(location.searchParams.get('state')).not.toContain(cookie.value);
      expect(cookie.attributes).toEqual(
        expect.arrayContaining(['httponly', 'secure', 'samesite=lax', 'path=/']),
      );
      expect(cookie.attributes).toContain('max-age=600');
    });

    it('issues a fresh state for every authorization request', async () => {
      const first = await request(app).get('/oauth/github').expect(302);
      const second = await request(app).get('/oauth/github').expect(302);

      expect(stateLocation(first)).not.toBe(stateLocation(second));
    });

    it('rejects a callback link from a browser that never started the flow', async () => {
      const otherFlow = await request(app).get('/oauth/github').expect(302);
      const otherState = new URL(otherFlow.headers.location).searchParams.get('state');

      const response = await request(app)
        .get('/oauth/github/callback')
        .query({ code: 'unrelated-code', state: otherState })
        .expect(302);

      expect(response.headers.location).toBe(`${APP_URL}/oauth/error`);
      expect(github._oauth2.getOAuthAccessToken).not.toHaveBeenCalled();
      expect(findUser).not.toHaveBeenCalled();
    });

    it('rejects a callback whose state belongs to a different flow', async () => {
      const ownFlow = await request(app).get('/oauth/github').expect(302);
      const otherFlow = await request(app).get('/oauth/github').expect(302);
      const ownCookie = getStateCookie(ownFlow, 'github');
      const otherState = new URL(otherFlow.headers.location).searchParams.get('state');

      const response = await request(app)
        .get('/oauth/github/callback')
        .set('Cookie', asCookie(ownCookie))
        .query({ code: 'unrelated-code', state: otherState })
        .expect(302);

      expect(response.headers.location).toBe(`${APP_URL}/oauth/error`);
      expect(github._oauth2.getOAuthAccessToken).not.toHaveBeenCalled();
    });

    it('rejects a callback that omits the state', async () => {
      const ownFlow = await request(app).get('/oauth/github').expect(302);
      const ownCookie = getStateCookie(ownFlow, 'github');

      const response = await request(app)
        .get('/oauth/github/callback')
        .set('Cookie', asCookie(ownCookie))
        .query({ code: 'unrelated-code' })
        .expect(302);

      expect(response.headers.location).toBe(`${APP_URL}/oauth/error`);
      expect(github._oauth2.getOAuthAccessToken).not.toHaveBeenCalled();
    });

    it('completes the login when the callback returns to the browser that started it', async () => {
      const flow = await request(app).get('/oauth/github').expect(302);
      const cookie = getStateCookie(flow, 'github');
      const state = new URL(flow.headers.location).searchParams.get('state');

      const response = await request(app)
        .get('/oauth/github/callback')
        .set('Cookie', asCookie(cookie))
        .query({ code: 'own-code', state })
        .expect(200);

      expect(response.body).toEqual({ userId: 'user-1' });
      expect(github._oauth2.getOAuthAccessToken).toHaveBeenCalledWith(
        'own-code',
        expect.objectContaining({ redirect_uri: `${APP_URL}/oauth/github/callback` }),
        expect.any(Function),
      );

      expect(getStateCookie(response, 'github')).toBeUndefined();
    });

    it('still completes the pending login after an unrelated callback reaches the browser', async () => {
      const ownFlow = await request(app).get('/oauth/github').expect(302);
      const otherFlow = await request(app).get('/oauth/github').expect(302);
      const ownCookie = getStateCookie(ownFlow, 'github');

      const unrelated = await request(app)
        .get('/oauth/github/callback')
        .set('Cookie', asCookie(ownCookie))
        .query({ code: 'unrelated-code', state: stateLocation(otherFlow) })
        .expect(302);

      expect(unrelated.headers.location).toBe(`${APP_URL}/oauth/error`);
      expect(getStateCookie(unrelated, 'github')).toBeUndefined();

      await request(app)
        .get('/oauth/github/callback')
        .set('Cookie', asCookie(ownCookie))
        .query({ code: 'own-code', state: stateLocation(ownFlow) })
        .expect(200);

      expect(github._oauth2.getOAuthAccessToken).toHaveBeenCalledTimes(1);
      expect(github._oauth2.getOAuthAccessToken).toHaveBeenCalledWith(
        'own-code',
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('completes logins started in two tabs, in either order', async () => {
      const firstTab = await request(app).get('/oauth/github').expect(302);
      const secondTab = await request(app)
        .get('/oauth/github')
        .set('Cookie', asCookie(getStateCookie(firstTab, 'github')))
        .expect(302);
      const binding = asCookie(getStateCookie(secondTab, 'github'));

      expect(binding).toBe(asCookie(getStateCookie(firstTab, 'github')));

      await request(app)
        .get('/oauth/github/callback')
        .set('Cookie', binding)
        .query({ code: 'first-code', state: stateLocation(firstTab) })
        .expect(200);

      await request(app)
        .get('/oauth/github/callback')
        .set('Cookie', binding)
        .query({ code: 'second-code', state: stateLocation(secondTab) })
        .expect(200);

      expect(github._oauth2.getOAuthAccessToken).toHaveBeenCalledTimes(2);
    });

    it('completes both logins when two tabs start before either has a binding', async () => {
      const [firstTab, secondTab] = await Promise.all([
        request(app).get('/oauth/github').expect(302),
        request(app).get('/oauth/github').expect(302),
      ]);
      const firstCookie = getStateCookie(firstTab, 'github');
      const secondCookie = getStateCookie(secondTab, 'github');
      const browserCookies = `${asCookie(firstCookie)}; ${asCookie(secondCookie)}`;

      expect(firstCookie.name).not.toBe(secondCookie.name);

      for (const [tab, code] of [
        [secondTab, 'second-code'],
        [firstTab, 'first-code'],
      ]) {
        await request(app)
          .get('/oauth/github/callback')
          .set('Cookie', browserCookies)
          .query({ code, state: stateLocation(tab) })
          .expect(200);
      }

      expect(github._oauth2.getOAuthAccessToken).toHaveBeenCalledTimes(2);
    });
  });

  describe('Apple', () => {
    it('stores a SameSite=None state cookie that survives the cross-site form_post callback', async () => {
      const response = await request(app).get('/oauth/apple').expect(302);

      const location = new URL(response.headers.location);
      const cookie = getStateCookie(response, 'apple');

      expect(location.origin).toBe('https://appleid.apple.com');
      expect(location.searchParams.get('response_mode')).toBe('form_post');
      expect(cookie.value).toMatch(BINDING_PATTERN);
      expect(location.searchParams.get('state')).not.toContain(cookie.value);
      expect(cookie.attributes).toEqual(
        expect.arrayContaining(['httponly', 'secure', 'samesite=none', 'path=/']),
      );
    });

    it('issues a fresh state for every authorization request', async () => {
      const first = await request(app).get('/oauth/apple').expect(302);
      const second = await request(app).get('/oauth/apple').expect(302);

      const firstState = new URL(first.headers.location).searchParams.get('state');
      const secondState = new URL(second.headers.location).searchParams.get('state');

      expect(firstState).not.toBe(secondState);
      expect(getStateCookie(second, 'apple').value).toMatch(BINDING_PATTERN);
    });

    it('rejects a form_post callback from a browser that never started the flow', async () => {
      const otherFlow = await request(app).get('/oauth/apple').expect(302);
      const otherState = new URL(otherFlow.headers.location).searchParams.get('state');

      const response = await request(app)
        .post('/oauth/apple/callback')
        .type('form')
        .send({ code: 'unrelated-code', state: otherState })
        .expect(302);

      expect(response.headers.location).toBe(`${APP_URL}/oauth/error`);
      expect(apple._oauth2.getOAuthAccessToken).not.toHaveBeenCalled();
    });

    it('exchanges the code when the form_post returns to the browser that started the flow', async () => {
      const flow = await request(app).get('/oauth/apple').expect(302);
      const cookie = getStateCookie(flow, 'apple');
      const state = new URL(flow.headers.location).searchParams.get('state');

      await request(app)
        .post('/oauth/apple/callback')
        .set('Cookie', asCookie(cookie))
        .type('form')
        .send({ code: 'own-code', state })
        .expect(500);

      expect(apple._oauth2.getOAuthAccessToken).toHaveBeenCalledWith(
        'own-code',
        expect.any(Object),
        expect.any(Function),
      );
    });
  });
});
