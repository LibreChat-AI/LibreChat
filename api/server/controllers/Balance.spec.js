jest.mock('~/models', () => ({
  findBalanceByUser: jest.fn(),
}));

const { findBalanceByUser } = require('~/models');
const balanceController = require('./Balance');

describe('balanceController', () => {
  const createResponse = () => ({
    locals: {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    sendStatus: jest.fn().mockReturnThis(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns no content without reading balance when balance config is disabled', async () => {
    const req = {
      user: { id: 'user-1' },
    };
    const res = createResponse();
    res.locals.balanceConfigEnabled = false;

    await balanceController(req, res);

    expect(findBalanceByUser).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(204);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('uses balance data attached by middleware without a second read', async () => {
    const req = {
      user: { id: 'user-1' },
    };
    const res = createResponse();
    res.locals.balanceConfigEnabled = true;
    res.locals.balanceData = {
      _id: 'balance-1',
      user: 'user-1',
      tokenCredits: 100,
      autoRefillEnabled: false,
    };

    await balanceController(req, res);

    expect(findBalanceByUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      user: 'user-1',
      tokenCredits: 100,
      autoRefillEnabled: false,
    });
  });

  it('returns not found when balance is enabled and no record exists', async () => {
    findBalanceByUser.mockResolvedValue(null);
    const req = {
      user: { id: 'user-1' },
    };
    const res = createResponse();
    res.locals.balanceConfigEnabled = true;

    await balanceController(req, res);

    expect(findBalanceByUser).toHaveBeenCalledWith('user-1');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Balance not found' });
  });
});
