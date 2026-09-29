const mockGetInvite = jest.fn();
const mockDeleteTokens = jest.fn();

jest.mock('@librechat/api', () => ({
  getInvite: (...args) => mockGetInvite(...args),
}));

jest.mock('~/models', () => ({
  createToken: jest.fn(),
  findToken: jest.fn(),
  deleteTokens: (...args) => mockDeleteTokens(...args),
}));

const checkInviteUser = require('./checkInviteUser');

const buildRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('checkInviteUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not consume the invite, so a later failure cannot destroy it', async () => {
    /** The reported bug: the invite was deleted here, before the schema, the
     *  allowed-domain check or the email-in-use check had run. A mistyped password
     *  confirmation left the invitee with no invite and no account. */
    mockGetInvite.mockResolvedValue({ token: 'hashed-invite', email: 'invitee@example.com' });
    const req = { body: { token: 'raw-token', email: 'invitee@example.com' } };
    const next = jest.fn();

    await checkInviteUser(req, buildRes(), next);

    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('hands the validated invite to the rest of the chain', async () => {
    const invite = { token: 'hashed-invite', email: 'invitee@example.com' };
    mockGetInvite.mockResolvedValue(invite);
    const req = { body: { token: 'raw-token', email: 'invitee@example.com' } };

    await checkInviteUser(req, buildRes(), jest.fn());

    expect(req.invite).toBe(invite);
  });

  it('rejects an invalid invite without touching the token store', async () => {
    mockGetInvite.mockResolvedValue(null);
    const res = buildRes();

    await checkInviteUser({ body: { token: 'raw-token', email: 'a@b.c' } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockDeleteTokens).not.toHaveBeenCalled();
  });

  it('passes straight through when no invite token is supplied', async () => {
    const next = jest.fn();

    await checkInviteUser({ body: {} }, buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockGetInvite).not.toHaveBeenCalled();
  });
});
