const bcrypt = require('bcryptjs');
/**
 * Backward compatibility for the auth-flow documents an operator who skipped the migration
 * script leaves behind in `tokens`.
 *
 * Each case seeds through the *pre-relocation* call — the flat `createToken` bound to the
 * `Token` model, and `createInvite` carrying the flat method set as its injected deps — so the
 * seeded document is the one the pre-split image wrote rather than a hand-built approximation.
 * The flow is then driven through the same real `AuthService` functions and `checkInviteUser`
 * middleware the deployment runs; nothing is mocked but SMTP delivery and the application
 * config, neither of which the process owns.
 *
 * Requirements: 1.10, 8.27
 */
jest.mock('~/server/utils', () => ({ sendEmail: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));

const { getAppConfig } = require('~/server/services/Config');

/**
 * `afterAll(jest.resetModules())` alone was insufficient here — it left the real graph resident
 * long enough to leak (intermittently) into a later suite (AuthService.spec.js) whose top-level
 * `jest.isolateModules` require then resolved these real instances instead of its mock-wired
 * ones, and its spies saw zero calls. Loading every REAL dependency inside `jest.isolateModules`
 * keeps them in an isolated registry that is discarded immediately, so this suite never leaves a
 * real `~/models` / `AuthService` graph in the shared registry. `mongoose` and
 * `mongodb-memory-server` are pulled from the SAME isolated registry so the connection this
 * suite drives is the one the real models registered their schemas against.
 */
let mongoose;
let MongoMemoryServer;
let createInvite;
let authTokens;
let createToken;
let findToken;
let createUser;
let User;
let checkInviteUser;
let registrationController;
let verifyEmail;
let resetPassword;

jest.isolateModules(() => {
  mongoose = require('mongoose');
  ({ MongoMemoryServer } = require('mongodb-memory-server'));
  ({ createInvite } = require('@librechat/api'));
  ({ authTokens, createToken, findToken, createUser } = require('~/models'));
  ({ User } = require('~/db/models'));
  checkInviteUser = require('~/server/middleware/checkInviteUser');
  ({ registrationController } = require('~/server/controllers/AuthController'));
  ({ verifyEmail, resetPassword } = require('~/server/services/AuthService'));
});

const PASSWORD_RESET = 'password_reset';
const EMAIL_VERIFICATION = 'email_verification';
const INVALID_RESET = 'Invalid or expired password reset token';
const INVALID_VERIFICATION = 'Invalid or expired email verification token';

let mongoServer;

const collection = (name) => mongoose.connection.db.collection(name);
const tokenDocs = () => collection('tokens').find({}).toArray();
const authTokenCount = () => collection('authtokens').countDocuments();

/** The pre-relocation invite deps: both methods bound to the `tokens` collection. */
const legacyInviteDeps = () => ({ createToken, findToken });

const seedUser = (overrides = {}) =>
  createUser(
    {
      provider: 'local',
      email: 'legacy@example.com',
      name: 'Legacy User',
      password: bcrypt.hashSync('original-password', 10),
      ...overrides,
    },
    undefined,
    true,
    true,
  );

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((existing) => existing.deleteMany({})));
  getAppConfig.mockResolvedValue({ registration: {}, balance: { enabled: false } });
});

describe('a `password_reset` document present only in `tokens`', () => {
  it('is treated as absent, and the source document stays in place', async () => {
    const user = await seedUser();
    const token = 'pre-relocation-reset-token';
    await createToken({
      userId: user._id,
      type: PASSWORD_RESET,
      token: bcrypt.hashSync(token, 10),
      createdAt: Date.now(),
      expiresIn: 900,
    });
    const seeded = await tokenDocs();

    const result = await resetPassword(user._id, token, 'brand-new-password');

    expect(result).toEqual(new Error(INVALID_RESET));
    expect(await tokenDocs()).toEqual(seeded);
    expect(await authTokenCount()).toBe(0);

    const untouched = await User.findById(user._id).select('+password').lean();
    expect(bcrypt.compareSync('original-password', untouched.password)).toBe(true);
  });

  it('is treated as absent in its legacy shape carrying no `type`, and stays in place', async () => {
    const user = await seedUser();
    const token = 'pre-relocation-legacy-reset-token';
    await createToken({
      userId: user._id,
      token: bcrypt.hashSync(token, 10),
      createdAt: Date.now(),
      expiresIn: 900,
    });
    const seeded = await tokenDocs();

    const result = await resetPassword(user._id, token, 'brand-new-password');

    expect(result).toEqual(new Error(INVALID_RESET));
    expect(await tokenDocs()).toEqual(seeded);
    expect(await authTokenCount()).toBe(0);
  });

  it('does not shadow a reset issued after the relocation', async () => {
    const user = await seedUser();
    const staleToken = 'pre-relocation-reset-token';
    await createToken({
      userId: user._id,
      type: PASSWORD_RESET,
      token: bcrypt.hashSync(staleToken, 10),
      createdAt: Date.now(),
      expiresIn: 900,
    });

    const currentToken = 'post-relocation-reset-token';
    await authTokens.createToken({
      userId: user._id,
      type: PASSWORD_RESET,
      token: bcrypt.hashSync(currentToken, 10),
      createdAt: Date.now(),
      expiresIn: 900,
    });

    const result = await resetPassword(user._id, currentToken, 'brand-new-password');

    expect(result).toEqual({ message: 'Password reset was successful' });
    expect(await tokenDocs()).toHaveLength(1);
    expect(await authTokenCount()).toBe(0);
  });
});

describe('an `email_verification` document present only in `tokens`', () => {
  const email = 'legacy-verify@example.com';

  it('is treated as absent, and the source document stays in place', async () => {
    const user = await seedUser({ email, emailVerified: false });
    const token = 'pre-relocation-verification-token';
    await createToken({
      userId: user._id,
      email,
      type: EMAIL_VERIFICATION,
      token: bcrypt.hashSync(token, 10),
      createdAt: Date.now(),
      expiresIn: 900,
    });
    const seeded = await tokenDocs();

    const result = await verifyEmail({ body: { email, token } });

    expect(result).toEqual(new Error(INVALID_VERIFICATION));
    expect(await tokenDocs()).toEqual(seeded);
    expect(await authTokenCount()).toBe(0);

    const unverified = await User.findById(user._id).lean();
    expect(unverified.emailVerified).toBe(false);
  });

  it('is treated as absent in its legacy shape carrying no `type`, and stays in place', async () => {
    const user = await seedUser({ email, emailVerified: false });
    const token = 'pre-relocation-legacy-verification-token';
    await createToken({
      userId: user._id,
      email,
      token: bcrypt.hashSync(token, 10),
      createdAt: Date.now(),
      expiresIn: 900,
    });
    const seeded = await tokenDocs();

    const result = await verifyEmail({ body: { email, token } });

    expect(result).toEqual(new Error(INVALID_VERIFICATION));
    expect(await tokenDocs()).toEqual(seeded);
    expect(await authTokenCount()).toBe(0);

    const unverified = await User.findById(user._id).lean();
    expect(unverified.emailVerified).toBe(false);
  });
});

describe('an invite document present only in `tokens`', () => {
  const email = 'legacy-invitee@example.com';

  const makeRes = () => {
    const json = jest.fn();
    return { status: jest.fn(() => ({ json })), json };
  };

  it('is treated as absent, and the source document stays in place', async () => {
    const encodedToken = await createInvite(email, legacyInviteDeps());
    const seeded = await tokenDocs();
    expect(seeded).toHaveLength(1);

    const req = { body: { token: encodedToken, email } };
    const res = makeRes();
    const next = jest.fn();

    await checkInviteUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid invite token' });
    expect(next).not.toHaveBeenCalled();
    expect(req.invite).toBeUndefined();
    expect(await tokenDocs()).toEqual(seeded);
    expect(await authTokenCount()).toBe(0);
  });

  it('is not consumed when an invite issued after the relocation is accepted', async () => {
    const staleToken = await createInvite(email, legacyInviteDeps());
    const currentToken = await createInvite(email, {
      createToken: authTokens.createToken,
      findToken: authTokens.findToken,
    });
    expect(currentToken).not.toBe(staleToken);

    /** The stale invite the migration left behind sits in `tokens`; the accepted invite
     * lives in `authtokens`. Consumption happens in `registrationController`, so the flow
     * runs the middleware then the controller — the real call site — and asserts the
     * `tokens` document is never touched while the `authtokens` invite is consumed. */
    const req = {
      body: {
        token: currentToken,
        email,
        name: 'Legacy Invitee',
        password: 'original-password',
        confirm_password: 'original-password',
      },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkInviteUser(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.invite.email).toBe(email);

    const controllerRes = {
      status: jest.fn(() => controllerRes),
      send: jest.fn(() => controllerRes),
      json: jest.fn(() => controllerRes),
    };
    await registrationController(req, controllerRes);

    expect(controllerRes.status).toHaveBeenCalledWith(200);
    expect(await authTokenCount()).toBe(0);
    expect(await tokenDocs()).toHaveLength(1);
  });
});
