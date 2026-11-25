const mockGetRetentionExpiry = jest.fn();
const mockGetAgentFileRetentionExpiry = jest.fn();

jest.mock('@librechat/api', () => ({
  getRetentionExpiry: (...args) => mockGetRetentionExpiry(...args),
  getAgentFileRetentionExpiry: (...args) => mockGetAgentFileRetentionExpiry(...args),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: {},
  createChatExpirationDate: jest.fn(),
}));
jest.mock('~/models', () => ({ getConvo: jest.fn() }));

const { getRetentionExpiry, getAgentFileRetentionExpiry } = require('./retention');

describe('event-bound file retention', () => {
  const expiredAt = new Date('2026-08-22T12:00:00.000Z');
  const req = { _agentEventBindingRetention: { isTemporary: false, expiredAt } };

  beforeEach(() => jest.clearAllMocks());

  it('uses the trusted binding deadline for generated files', async () => {
    await expect(getRetentionExpiry(req)).resolves.toEqual({ expiredAt });
    expect(mockGetRetentionExpiry).not.toHaveBeenCalled();
  });

  it('uses the same binding deadline for agent resource files', async () => {
    await expect(
      getAgentFileRetentionExpiry({ req, tool_resource: 'execute_code' }),
    ).resolves.toEqual({ expiredAt });
    expect(mockGetAgentFileRetentionExpiry).not.toHaveBeenCalled();
  });
});
