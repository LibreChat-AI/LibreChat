import { getTchatCredit } from './credit';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
}));

const reply = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 503, json: async () => body }) as unknown as Response;

describe('getTchatCredit', () => {
  const env = { ...process.env };
  const req = { user: { id: 'u1', email: 'a@b.co', openidId: '42' } };

  beforeEach(() => {
    process.env.TCHAT_BROKER_ORIGIN = 'http://tchat-broker:8081/';
    process.env.TCHAT_BROKER_SHARED_KEY = 'shared-key';
    process.env.TCHAT_BROKER_BASE_URL = 'http://tchat-broker:8081/v1';
  });

  afterAll(() => {
    process.env = env;
  });

  it('asks the broker as the signed-in user and returns balance and currency', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply({ balance_cents: 1234, currency: 'USD' }));

    await expect(getTchatCredit(req, fetchImpl)).resolves.toEqual({
      balance_cents: 1234,
      currency: 'USD',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://tchat-broker:8081/tchat/credit',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer shared-key',
          'X-Tchat-User-Email': 'a@b.co',
          'X-Tchat-User-Openid': '42',
        }),
      }),
    );
  });

  it('returns null when the broker is not configured', async () => {
    delete process.env.TCHAT_BROKER_ORIGIN;
    const fetchImpl = jest.fn();

    await expect(getTchatCredit(req, fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null on a broker error or an unusable body', async () => {
    await expect(
      getTchatCredit(req, jest.fn().mockResolvedValue(reply({}, false))),
    ).resolves.toBeNull();
    await expect(
      getTchatCredit(req, jest.fn().mockResolvedValue(reply({ x: 1 }))),
    ).resolves.toBeNull();
    await expect(
      getTchatCredit(req, jest.fn().mockRejectedValue(new Error('down'))),
    ).resolves.toBeNull();
  });
});
