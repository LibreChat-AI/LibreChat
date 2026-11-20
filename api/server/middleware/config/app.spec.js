const mockGetAppConfig = jest.fn();
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: mockLogger,
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

const configMiddleware = require('./app');

describe('configMiddleware logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('never logs the raw error when both config reads fail', async () => {
    const secretError = Object.assign(new Error('mongodb://admin:secret@db failed'), {
      query: { secret: 'value' },
    });
    mockGetAppConfig.mockRejectedValue(secretError);
    const next = jest.fn();

    await configMiddleware({ user: { id: 'user-1', role: 'USER' }, path: '/x' }, {}, next);

    expect(next).toHaveBeenCalledWith(secretError);
    expect(mockLogger.error).toHaveBeenCalled();
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('secret');
  });

  it('never logs the raw error from the strict config read', async () => {
    const secretError = new Error('mongodb://admin:secret@db failed');
    mockGetAppConfig.mockRejectedValue(secretError);
    const next = jest.fn();

    await configMiddleware.strictConfigMiddleware(
      { user: { id: 'user-1', role: 'USER' }, path: '/x' },
      {},
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('secret');
  });
});
