const bcrypt = require('bcryptjs');
/**
 * The redirected auth flows, end to end against a real MongoDB.
 *
 * Every layer under test is real: the token method sets from
 * `@librechat/data-schemas`, the `AuthService` functions, the invite helpers
 * from `@librechat/api`, and the `checkInviteUser` middleware. Only the two
 * boundaries the process cannot own are stubbed — SMTP delivery and the
 * on-disk/DB application config — and SMTP is stubbed in a way that still
 * carries the issued link, so each flow is driven by the token the production
 * code actually hands the user.
 */
jest.mock('~/server/utils', () => ({ sendEmail: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));

const { sendEmail } = require('~/server/utils');
const { getAppConfig } = require('~/server/services/Config');

/** `AuthService` snapshots the client domain at module load, so it is set before the require. */
const priorDomainClient = process.env.DOMAIN_CLIENT;
process.env.DOMAIN_CLIENT = 'https://chat.example.com';

/**
 * This suite requires the REAL `~/models` / `AuthService` graph (no `jest.mock`). Left in the
 * shared module registry, that un-mocked graph leaks into a later suite (AuthService.spec.js)
 * whose top-level `jest.isolateModules` require then resolves these real instances instead of
 * its mock-wired ones, and its spies see zero calls. `afterAll(jest.resetModules())` alone did
 * not reliably prevent this. Loading every REAL dependency inside `jest.isolateModules` keeps
 * them in an isolated registry that is discarded immediately, so this suite never leaves a real
 * graph in the shared registry. `mongoose` and `mongodb-memory-server` come from the SAME
 * isolated registry, so the connection this suite drives is the one the real models registered
 * their schemas against.
 */
let mongoose;
let MongoMemoryServer;
let createInvite;
let authTokens;
let createUser;
let createToken;
let User;
let checkInviteUser;
let registrationController;
let verifyEmail;
let registerUser;
let resetPassword;
let requestPasswordReset;
let resendVerificationEmail;

jest.isolateModules(() => {
  mongoose = require('mongoose');
  ({ MongoMemoryServer } = require('mongodb-memory-server'));
  ({ createInvite } = require('@librechat/api'));
  ({ authTokens, createUser, createToken } = require('~/models'));
  ({ User } = require('~/db/models'));
  checkInviteUser = require('~/server/middleware/checkInviteUser');
  ({ registrationController } = require('~/server/controllers/AuthController'));
  ({
    verifyEmail,
    registerUser,
    resetPassword,
    requestPasswordReset,
    resendVerificationEmail,
  } = require('~/server/services/AuthService'));
});

const PASSWORD_RESET = 'password_reset';
const EMAIL_VERIFICATION = 'email_verification';

let mongoServer;

const collection = (name) => mongoose.connection.db.collection(name);
const authTokenDocs = () => collection('authtokens').find({}).toArray();
const tokenCount = () => collection('tokens').countDocuments();

const lastEmail = () => sendEmail.mock.calls.at(-1)?.[0];

const emailedResetToken = () => new URL(lastEmail().payload.link).searchParams.get('token');
const emailedVerifyToken = () =>
  new URL(lastEmail().payload.verificationLink).searchParams.get('token');

const seedUser = (overrides = {}) =>
  createUser(
    {
      provider: 'local',
      email: 'reset@example.com',
      name: 'Reset User',
      password: bcrypt.hashSync('original-password', 10),
      ...overrides,
    },
    undefined,
    true,
    true,
  );

beforeAll(async () => {
  process.env.EMAIL_HOST = 'smtp.example.com';
  process.env.EMAIL_FROM = 'noreply@example.com';

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  delete process.env.EMAIL_HOST;
  delete process.env.EMAIL_FROM;
  if (priorDomainClient === undefined) {
    delete process.env.DOMAIN_CLIENT;
  } else {
    process.env.DOMAIN_CLIENT = priorDomainClient;
  }

  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((existing) => existing.deleteMany({})));
  getAppConfig.mockResolvedValue({ registration: {}, balance: { enabled: false } });
});

describe('password reset against `authtokens`', () => {
  it('stores the requested reset token in `authtokens` and nothing in `tokens`', async () => {
    const user = await seedUser();

    const result = await requestPasswordReset({ body: { email: user.email }, ip: '192.0.2.10' });

    expect(result.message).toMatch(/password reset link has been sent/);
    expect(await tokenCount()).toBe(0);

    const [resetDoc] = await authTokenDocs();
    expect(resetDoc.type).toBe(PASSWORD_RESET);
    expect(resetDoc.userId.toString()).toBe(user._id.toString());
    expect(resetDoc.expiresAt).toBeInstanceOf(Date);
    expect(bcrypt.compareSync(emailedResetToken(), resetDoc.token)).toBe(true);
  });

  it('accepts the emailed token, updates the password, and clears the document', async () => {
    const user = await seedUser();
    await requestPasswordReset({ body: { email: user.email }, ip: '192.0.2.10' });

    const result = await resetPassword(user._id, emailedResetToken(), 'brand-new-password');

    expect(result).toEqual({ message: 'Password reset was successful' });
    expect(await authTokenDocs()).toHaveLength(0);
    expect(await tokenCount()).toBe(0);

    const updated = await User.findById(user._id).select('+password').lean();
    expect(bcrypt.compareSync('brand-new-password', updated.password)).toBe(true);
  });

  it('rejects a token that does not match and leaves the document in place', async () => {
    const user = await seedUser();
    await requestPasswordReset({ body: { email: user.email }, ip: '192.0.2.10' });

    const result = await resetPassword(user._id, 'not-the-issued-token', 'brand-new-password');

    expect(result).toEqual(new Error('Invalid or expired password reset token'));
    expect(await authTokenDocs()).toHaveLength(1);

    const untouched = await User.findById(user._id).select('+password').lean();
    expect(bcrypt.compareSync('original-password', untouched.password)).toBe(true);
  });

  it('rejects a reset when no token was ever issued', async () => {
    const user = await seedUser();

    const result = await resetPassword(user._id, 'any-token', 'brand-new-password');

    expect(result).toEqual(new Error('Invalid or expired password reset token'));
  });

  it('resolves and clears a legacy-shape reset document carrying no `type`', async () => {
    const user = await seedUser();
    const token = 'legacy-reset-token';

    await authTokens.createToken({
      userId: user._id,
      token: bcrypt.hashSync(token, 10),
      createdAt: Date.now(),
      expiresIn: 900,
    });

    const result = await resetPassword(user._id, token, 'brand-new-password');

    expect(result).toEqual({ message: 'Password reset was successful' });
    expect(await authTokenDocs()).toHaveLength(0);
  });

  it('replaces an outstanding reset token when a second request arrives', async () => {
    const user = await seedUser();

    await requestPasswordReset({ body: { email: user.email }, ip: '192.0.2.10' });
    const firstToken = emailedResetToken();
    await requestPasswordReset({ body: { email: user.email }, ip: '192.0.2.10' });
    const secondToken = emailedResetToken();

    expect(await authTokenDocs()).toHaveLength(1);
    expect(await resetPassword(user._id, firstToken, 'brand-new-password')).toEqual(
      new Error('Invalid or expired password reset token'),
    );
    expect(await resetPassword(user._id, secondToken, 'brand-new-password')).toEqual({
      message: 'Password reset was successful',
    });
  });

  it('reports the generic message and writes no token for an unknown email', async () => {
    const result = await requestPasswordReset({
      body: { email: 'nobody@example.com' },
      ip: '192.0.2.10',
    });

    expect(result.message).toMatch(/password reset link has been sent/);
    expect(await authTokenDocs()).toHaveLength(0);
    expect(await tokenCount()).toBe(0);
  });
});

describe('email verification against `authtokens`', () => {
  const email = 'verify@example.com';

  it('issues the registration verification token into `authtokens`', async () => {
    const result = await registerUser({
      name: 'Verify User',
      email,
      password: 'original-password',
      confirm_password: 'original-password',
    });

    expect(result.status).toBe(200);
    expect(await tokenCount()).toBe(0);

    const [verifyDoc] = await authTokenDocs();
    expect(verifyDoc.type).toBe(EMAIL_VERIFICATION);
    expect(verifyDoc.email).toBe(email);
    expect(bcrypt.compareSync(emailedVerifyToken(), verifyDoc.token)).toBe(true);
  });

  it('verifies the registered user with the emailed token and clears the document', async () => {
    await registerUser({
      name: 'Verify User',
      email,
      password: 'original-password',
      confirm_password: 'original-password',
    });

    const result = await verifyEmail({ body: { email, token: emailedVerifyToken() } });

    expect(result).toEqual({ message: 'Email verification was successful', status: 'success' });
    expect(await authTokenDocs()).toHaveLength(0);
    expect(await tokenCount()).toBe(0);

    const verified = await User.findOne({ email }).lean();
    expect(verified.emailVerified).toBe(true);
  });

  it('rejects a verification token that does not match and leaves the document in place', async () => {
    await registerUser({
      name: 'Verify User',
      email,
      password: 'original-password',
      confirm_password: 'original-password',
    });

    const result = await verifyEmail({ body: { email, token: 'not-the-issued-token' } });

    expect(result).toEqual(new Error('Invalid or expired email verification token'));
    expect(await authTokenDocs()).toHaveLength(1);

    const unverified = await User.findOne({ email }).lean();
    expect(unverified.emailVerified).toBe(false);
  });

  it('resolves and clears a legacy-shape verification document carrying no `type`', async () => {
    const user = await seedUser({ email, emailVerified: false });
    const token = 'legacy-verification-token';

    await authTokens.createToken({
      userId: user._id,
      email,
      token: bcrypt.hashSync(token, 10),
      createdAt: Date.now(),
      expiresIn: 900,
    });

    const result = await verifyEmail({ body: { email, token } });

    expect(result).toEqual({ message: 'Email verification was successful', status: 'success' });
    expect(await authTokenDocs()).toHaveLength(0);
  });

  it('resends a fresh token into `authtokens`, retiring the previous one', async () => {
    await registerUser({
      name: 'Verify User',
      email,
      password: 'original-password',
      confirm_password: 'original-password',
    });
    const registrationToken = emailedVerifyToken();

    const result = await resendVerificationEmail({ body: { email } });
    const resentToken = emailedVerifyToken();

    expect(result.status).toBe(200);
    expect(resentToken).not.toBe(registrationToken);
    expect(await authTokenDocs()).toHaveLength(1);
    expect(await tokenCount()).toBe(0);

    expect(await verifyEmail({ body: { email, token: registrationToken } })).toEqual(
      new Error('Invalid or expired email verification token'),
    );
    expect(await verifyEmail({ body: { email, token: resentToken } })).toEqual({
      message: 'Email verification was successful',
      status: 'success',
    });
  });

  it('reports the generic message and writes no token when resending for an unknown email', async () => {
    const result = await resendVerificationEmail({ body: { email: 'nobody@example.com' } });

    expect(result.status).toBe(200);
    expect(await authTokenDocs()).toHaveLength(0);
    expect(await tokenCount()).toBe(0);
  });
});

describe('invite issuance and consumption against `authtokens`', () => {
  const email = 'invitee@example.com';
  const inviteDeps = () => ({
    createToken: authTokens.createToken,
    findToken: authTokens.findToken,
  });

  const makeRes = () => {
    const json = jest.fn();
    return { status: jest.fn(() => ({ json })), json };
  };

  it('writes the issued invite to `authtokens` and nothing to `tokens`', async () => {
    const encodedToken = await createInvite(email, inviteDeps());

    expect(typeof encodedToken).toBe('string');
    expect(await tokenCount()).toBe(0);

    const [inviteDoc] = await authTokenDocs();
    expect(inviteDoc.email).toBe(email);
    expect(inviteDoc.type).toBeUndefined();
    expect(inviteDoc.expiresAt).toBeInstanceOf(Date);
  });

  /**
   * The invite is consumed by `registrationController`, not by the middleware:
   * `checkInviteUser` only attaches `req.invite`, and the controller deletes the invite
   * from `authtokens` once the account exists. This drives the real call site — the
   * middleware then the controller — rather than asserting a delete the middleware no
   * longer performs. The invite carries no `type` field, so it is identified apart from
   * the `email_verification` token registration issues on the same collection.
   */
  it('consumes the invite through the registration controller and deletes it from `authtokens`', async () => {
    const encodedToken = await createInvite(email, inviteDeps());

    const [inviteDoc] = await authTokenDocs();
    expect(inviteDoc.type).toBeUndefined();

    const req = {
      body: {
        token: encodedToken,
        email,
        name: 'Invited User',
        password: 'original-password',
        confirm_password: 'original-password',
      },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkInviteUser(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.invite.email).toBe(email);

    const controllerRes = {
      status: jest.fn(() => controllerRes),
      send: jest.fn(() => controllerRes),
      json: jest.fn(() => controllerRes),
    };
    await registrationController(req, controllerRes);

    expect(controllerRes.status).toHaveBeenCalledWith(200);

    /** The account was created and the invite consumed from `authtokens`; no invite
     * (a `type`-less document) remains, and nothing was written to `tokens`. */
    const remaining = await authTokenDocs();
    expect(remaining.some((doc) => doc.type === undefined)).toBe(false);
    expect(remaining.some((doc) => doc._id.equals(inviteDoc._id))).toBe(false);
    expect(await tokenCount()).toBe(0);
  });

  it('rejects an invite token that matches no `authtokens` document', async () => {
    const req = { body: { token: 'never-issued', email } };
    const res = makeRes();
    const next = jest.fn();

    await checkInviteUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid invite token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a valid invite presented with a different email and leaves it in place', async () => {
    const encodedToken = await createInvite(email, inviteDeps());

    const req = { body: { token: encodedToken, email: 'someone-else@example.com' } };
    const res = makeRes();
    const next = jest.fn();

    await checkInviteUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
    expect(await authTokenDocs()).toHaveLength(1);
  });

  it('passes through untouched when the request carries no invite token', async () => {
    const req = { body: { email } };
    const res = makeRes();
    const next = jest.fn();

    await checkInviteUser(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('`authtokens` document shape', () => {
  it('matches the `tokens` document shape field for field', async () => {
    const user = await seedUser();
    const data = {
      userId: user._id,
      email: user.email,
      type: PASSWORD_RESET,
      identifier: 'shape-check',
      token: 'shape-check-hash',
      createdAt: Date.now(),
      expiresIn: 900,
    };

    await createToken(data);
    await authTokens.createToken(data);

    const [tokenDoc] = await collection('tokens').find({}).toArray();
    const [authTokenDoc] = await authTokenDocs();

    expect(Object.keys(authTokenDoc).sort()).toEqual(Object.keys(tokenDoc).sort());
  });
});
