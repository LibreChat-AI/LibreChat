const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
const mockVerifyOTPOrBackupCode = jest.fn();
const mockGenerateTOTPSecret = jest.fn();
const mockGenerateBackupCodes = jest.fn();
const mockEncryptV3 = jest.fn();
const mockGetTOTPSecret = jest.fn();
const mockVerifyTOTP = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  encryptV3: (...args) => mockEncryptV3(...args),
  logger: { error: jest.fn() },
}));

jest.mock('~/server/services/twoFactorService', () => ({
  verifyOTPOrBackupCode: (...args) => mockVerifyOTPOrBackupCode(...args),
  generateBackupCodes: (...args) => mockGenerateBackupCodes(...args),
  generateTOTPSecret: (...args) => mockGenerateTOTPSecret(...args),
  verifyBackupCode: jest.fn(),
  getTOTPSecret: (...args) => mockGetTOTPSecret(...args),
  verifyTOTP: (...args) => mockVerifyTOTP(...args),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  updateUser: (...args) => mockUpdateUser(...args),
}));

const {
  enable2FA,
  confirm2FA,
  disable2FA,
  regenerateBackupCodes,
} = require('~/server/controllers/TwoFactorController');

function createRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const PLAIN_CODES = ['code1', 'code2', 'code3'];
const CODE_OBJECTS = [
  { codeHash: 'h1', used: false, usedAt: null },
  { codeHash: 'h2', used: false, usedAt: null },
  { codeHash: 'h3', used: false, usedAt: null },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerateTOTPSecret.mockReturnValue('NEWSECRET');
  mockGenerateBackupCodes.mockResolvedValue({ plainCodes: PLAIN_CODES, codeObjects: CODE_OBJECTS });
  mockEncryptV3.mockReturnValue('encrypted-secret');
  mockGetTOTPSecret.mockResolvedValue('plain-secret');
  mockVerifyTOTP.mockResolvedValue(true);
});

/** Any write that moves the pending or live credentials strands an in-flight required enrollment. */
const CLEARED_NONCES = {
  twoFactorAcknowledgementNonceHash: null,
  twoFactorFinalizationNonceHash: null,
};

describe('required-enrollment nonce cleanup', () => {
  it('clears stale nonce state when setup is regenerated', async () => {
    mockGetUserById.mockResolvedValue({ _id: 'user1', twoFactorEnabled: false, email: 'a@b.com' });
    mockUpdateUser.mockResolvedValue({ email: 'a@b.com' });

    await enable2FA({ user: { id: 'user1' }, body: {} }, createRes());

    expect(mockUpdateUser.mock.calls[0][1]).toMatchObject(CLEARED_NONCES);
  });

  it('clears stale nonce state when 2FA is confirmed from account settings', async () => {
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: false,
      pendingTotpSecret: 'encrypted-secret',
      pendingBackupCodes: CODE_OBJECTS,
    });
    mockUpdateUser.mockResolvedValue({});
    const res = createRes();

    await confirm2FA({ user: { id: 'user1' }, body: { token: '123456' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUpdateUser.mock.calls[0][1]).toMatchObject({
      twoFactorEnabled: true,
      pendingTotpSecret: null,
      pendingBackupCodes: [],
      ...CLEARED_NONCES,
    });
  });

  it('clears stale nonce state when 2FA is disabled', async () => {
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    });
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: true });
    mockUpdateUser.mockResolvedValue({});
    const res = createRes();

    await disable2FA({ user: { id: 'user1' }, body: { token: '123456' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUpdateUser.mock.calls[0][1]).toMatchObject({
      twoFactorEnabled: false,
      totpSecret: null,
      ...CLEARED_NONCES,
    });
  });
});

describe('enable2FA', () => {
  it('allows first-time setup without token — writes to pending fields', async () => {
    const req = { user: { id: 'user1' }, body: {} };
    const res = createRes();
    mockGetUserById.mockResolvedValue({ _id: 'user1', twoFactorEnabled: false, email: 'a@b.com' });
    mockUpdateUser.mockResolvedValue({ email: 'a@b.com' });

    await enable2FA(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ otpauthUrl: expect.any(String), backupCodes: PLAIN_CODES }),
    );
    expect(mockVerifyOTPOrBackupCode).not.toHaveBeenCalled();
    const updateCall = mockUpdateUser.mock.calls[0][1];
    expect(updateCall).toHaveProperty('pendingTotpSecret', 'encrypted-secret');
    expect(updateCall).toHaveProperty('pendingBackupCodes', CODE_OBJECTS);
    expect(updateCall).not.toHaveProperty('twoFactorEnabled');
    expect(updateCall).not.toHaveProperty('totpSecret');
    expect(updateCall).not.toHaveProperty('backupCodes');
  });

  it('re-enrollment writes to pending fields, leaving live 2FA intact', async () => {
    const req = { user: { id: 'user1' }, body: { token: '123456' } };
    const res = createRes();
    const existingUser = {
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
      email: 'a@b.com',
    };
    mockGetUserById.mockResolvedValue(existingUser);
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: true });
    mockUpdateUser.mockResolvedValue({ email: 'a@b.com' });

    await enable2FA(req, res);

    expect(mockVerifyOTPOrBackupCode).toHaveBeenCalledWith({
      user: existingUser,
      token: '123456',
      backupCode: undefined,
      persistBackupUse: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    const updateCall = mockUpdateUser.mock.calls[0][1];
    expect(updateCall).toHaveProperty('pendingTotpSecret', 'encrypted-secret');
    expect(updateCall).toHaveProperty('pendingBackupCodes', CODE_OBJECTS);
    expect(updateCall).not.toHaveProperty('twoFactorEnabled');
    expect(updateCall).not.toHaveProperty('totpSecret');
  });

  it('allows re-enrollment with valid backup code (persistBackupUse: false)', async () => {
    const req = { user: { id: 'user1' }, body: { backupCode: 'backup123' } };
    const res = createRes();
    const existingUser = {
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
      email: 'a@b.com',
    };
    mockGetUserById.mockResolvedValue(existingUser);
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: true });
    mockUpdateUser.mockResolvedValue({ email: 'a@b.com' });

    await enable2FA(req, res);

    expect(mockVerifyOTPOrBackupCode).toHaveBeenCalledWith(
      expect.objectContaining({ persistBackupUse: false }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns error when no token provided and 2FA is enabled', async () => {
    const req = { user: { id: 'user1' }, body: {} };
    const res = createRes();
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    });
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: false, status: 400 });

    await enable2FA(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('returns 401 when invalid token provided and 2FA is enabled', async () => {
    const req = { user: { id: 'user1' }, body: { token: 'wrong' } };
    const res = createRes();
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    });
    mockVerifyOTPOrBackupCode.mockResolvedValue({
      verified: false,
      status: 401,
      message: 'Invalid token or backup code',
    });

    await enable2FA(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid token or backup code' });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});

describe('regenerateBackupCodes', () => {
  it('returns 404 when user not found', async () => {
    const req = { user: { id: 'user1' }, body: {} };
    const res = createRes();
    mockGetUserById.mockResolvedValue(null);

    await regenerateBackupCodes(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'User not found' });
  });

  it('requires OTP when 2FA is enabled', async () => {
    const req = { user: { id: 'user1' }, body: { token: '123456' } };
    const res = createRes();
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    });
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: true });
    mockUpdateUser.mockResolvedValue({});

    await regenerateBackupCodes(req, res);

    expect(mockVerifyOTPOrBackupCode).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      backupCodes: PLAIN_CODES,
      backupCodesHash: CODE_OBJECTS,
    });
  });

  it('returns error when no token provided and 2FA is enabled', async () => {
    const req = { user: { id: 'user1' }, body: {} };
    const res = createRes();
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    });
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: false, status: 400 });

    await regenerateBackupCodes(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 when invalid token provided and 2FA is enabled', async () => {
    const req = { user: { id: 'user1' }, body: { token: 'wrong' } };
    const res = createRes();
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    });
    mockVerifyOTPOrBackupCode.mockResolvedValue({
      verified: false,
      status: 401,
      message: 'Invalid token or backup code',
    });

    await regenerateBackupCodes(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid token or backup code' });
  });

  it('includes backupCodesHash in response', async () => {
    const req = { user: { id: 'user1' }, body: { token: '123456' } };
    const res = createRes();
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    });
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: true });
    mockUpdateUser.mockResolvedValue({});

    await regenerateBackupCodes(req, res);

    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody).toHaveProperty('backupCodesHash', CODE_OBJECTS);
    expect(responseBody).toHaveProperty('backupCodes', PLAIN_CODES);
  });

  it('allows regeneration without token when 2FA is not enabled', async () => {
    const req = { user: { id: 'user1' }, body: {} };
    const res = createRes();
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: false,
    });
    mockUpdateUser.mockResolvedValue({});

    await regenerateBackupCodes(req, res);

    expect(mockVerifyOTPOrBackupCode).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      backupCodes: PLAIN_CODES,
      backupCodesHash: CODE_OBJECTS,
    });
  });
});
