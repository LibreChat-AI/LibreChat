const mockCreateMCPAppRateLimiter = jest.fn((kind) => `${kind}-limiter`);
const mockCreateMCPAppAdmissionRateLimiter = jest.fn(() => 'admission-limiter');
const mockLimiterCache = jest.fn((key) => `${key}-store`);
const mockLogViolation = jest.fn();
const mockGetMCPAppsPolicy = jest.fn(() => ({ maxAdmissionRequestsPerMinute: 240 }));

jest.mock('@librechat/api', () => ({
  createMCPAppRateLimiter: (...args) => mockCreateMCPAppRateLimiter(...args),
  createMCPAppAdmissionRateLimiter: (...args) => mockCreateMCPAppAdmissionRateLimiter(...args),
  limiterCache: (...args) => mockLimiterCache(...args),
}));

jest.mock('~/cache/logViolation', () => mockLogViolation);
jest.mock('~/config', () => ({
  getMCPServersRegistry: () => ({ getMCPAppsPolicy: mockGetMCPAppsPolicy }),
}));

describe('MCP App limiter wiring', () => {
  const previousScore = process.env.TOOL_CALL_VIOLATION_SCORE;

  beforeAll(() => {
    process.env.TOOL_CALL_VIOLATION_SCORE = '7';
  });

  afterAll(() => {
    if (previousScore === undefined) {
      delete process.env.TOOL_CALL_VIOLATION_SCORE;
    } else {
      process.env.TOOL_CALL_VIOLATION_SCORE = previousScore;
    }
  });

  it.each([
    ['resource', './mcpAppResourceLimiter', 'mcp_app_resource_limiter'],
    ['toolCall', './mcpAppToolCallLimiter', 'mcp_app_tool_call_limiter'],
  ])('wires the %s limiter with its independent store', (kind, modulePath, cacheKey) => {
    expect(require(modulePath)).toBe(`${kind}-limiter`);
    expect(mockLimiterCache).toHaveBeenCalledWith(cacheKey);
    expect(mockCreateMCPAppRateLimiter).toHaveBeenCalledWith(kind, {
      store: `${cacheKey}-store`,
      logViolation: mockLogViolation,
      score: '7',
    });
  });

  it('wires one shared pre-admission limiter to the registry base policy', () => {
    expect(require('./mcpAppAdmissionLimiter')).toBe('admission-limiter');
    expect(mockLimiterCache).toHaveBeenCalledWith('mcp_app_admission_limiter');
    expect(mockCreateMCPAppAdmissionRateLimiter).toHaveBeenCalledWith({
      store: 'mcp_app_admission_limiter-store',
      getLimit: expect.any(Function),
      logViolation: mockLogViolation,
      score: '7',
    });

    const [[{ getLimit }]] = mockCreateMCPAppAdmissionRateLimiter.mock.calls;
    expect(getLimit()).toBe(240);
    expect(mockGetMCPAppsPolicy).toHaveBeenCalledTimes(1);
  });
});
