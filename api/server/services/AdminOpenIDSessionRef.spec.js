const { CacheKeys } = require('librechat-data-provider');

const mockStore = {};
const mockGetLogStores = jest.fn(() => mockStore);
const mockLogger = { warn: jest.fn() };
const mockRemember = jest.fn();
const mockRecall = jest.fn();
const mockRotate = jest.fn();

jest.mock(
  '~/cache/getLogStores',
  () =>
    (...args) =>
      mockGetLogStores(...args),
);
jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
  DEFAULT_REFRESH_TOKEN_EXPIRY: 1000 * 60 * 60 * 24 * 30,
}));
jest.mock('@librechat/api', () => ({
  math: jest.requireActual('@librechat/api').math,
  rememberAdminOpenIDSessionRef: (...args) => mockRemember(...args),
  recallAdminOpenIDSessionRef: (...args) => mockRecall(...args),
  rotateAdminOpenIDSessionRef: (...args) => mockRotate(...args),
}));
jest.mock('./OpenIDSessions', () => ({
  sessionAuthorizationRef: { enforcement: false },
}));

const openIdSessions = require('./OpenIDSessions');
const {
  rememberAdminOpenIDSessionRef,
  recallAdminOpenIDSessionRef,
  rotateAdminOpenIDSessionRef,
} = require('./AdminOpenIDSessionRef');

beforeEach(() => {
  jest.clearAllMocks();
  openIdSessions.sessionAuthorizationRef.enforcement = false;
});

describe('AdminOpenIDSessionRef wiring', () => {
  it('remembers a session ref against the admin cache store with the current enforcement and ttl', async () => {
    await rememberAdminOpenIDSessionRef('rt-1', 'session-1');

    expect(mockGetLogStores).toHaveBeenCalledWith(CacheKeys.ADMIN_OPENID_SESSION_REF);
    expect(mockRemember).toHaveBeenCalledWith(
      { cache: mockStore, logger: mockLogger },
      'rt-1',
      'session-1',
      { enforcement: false, ttlMs: expect.any(Number) },
    );
  });

  it('recalls a session ref with the current enforcement flag', async () => {
    openIdSessions.sessionAuthorizationRef.enforcement = true;

    await recallAdminOpenIDSessionRef('rt-1');

    expect(mockRecall).toHaveBeenCalledWith({ cache: mockStore, logger: mockLogger }, 'rt-1', {
      enforcement: true,
      ttlMs: expect.any(Number),
    });
  });

  it('rotates a session ref against the admin cache store', async () => {
    await rotateAdminOpenIDSessionRef('rt-old', 'rt-new', 'session-1');

    expect(mockRotate).toHaveBeenCalledWith(
      { cache: mockStore, logger: mockLogger },
      'rt-old',
      'rt-new',
      'session-1',
      { enforcement: false, ttlMs: expect.any(Number) },
    );
  });
});
