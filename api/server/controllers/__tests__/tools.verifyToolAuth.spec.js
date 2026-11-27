jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  checkAccess: jest.fn(),
  loadWebSearchAuth: jest.fn(),
}));

jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
  createToolCall: jest.fn(),
  getToolCallsByConvo: jest.fn(),
  getMessage: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  processFileURL: jest.fn(),
  uploadImageBuffer: jest.fn(),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/app/clients/tools/util', () => ({
  loadTools: jest.fn(),
}));

const { Tools, AuthType } = require('librechat-data-provider');
const { loadWebSearchAuth } = require('@librechat/api');
const { verifyToolAuth } = require('../tools');

/**
 * Phase 8 behavioral pin: `verifyToolAuth(execute_code)` unconditionally
 * returns system-authenticated. Sandbox auth moved server-side into the
 * agents library, so the per-user `CODE_API_KEY` check that previously
 * gated this endpoint is gone. The deployment contract is: if the
 * admin enabled the `execute_code` capability, the sandbox is
 * reachable. This endpoint does not probe reachability (would be too
 * expensive per UI-gate query); failures surface at execution time.
 *
 * A regression where someone re-adds an auth check here would
 * resurrect the per-user key-entry dialog on the client, which Phase 8
 * explicitly removed. Pin the contract.
 */
describe('verifyToolAuth — execute_code system-auth contract', () => {
  const makeReq = (toolId) => ({
    params: { toolId },
    user: { id: 'user-1' },
    config: {},
  });

  const makeRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  it('returns authenticated: true with SYSTEM_DEFINED for execute_code', async () => {
    const res = makeRes();
    await verifyToolAuth(makeReq(Tools.execute_code), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      authenticated: true,
      message: AuthType.SYSTEM_DEFINED,
    });
  });

  it('returns 404 for unknown tool ids (not in directCallableTools)', async () => {
    const res = makeRes();
    await verifyToolAuth(makeReq('not_a_real_tool'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Tool not found' });
  });

  it('does NOT invoke loadAuthValues for execute_code (no per-user credential check)', async () => {
    /* Regression guard: a future refactor that threads per-user auth back
       in would resurface the key-entry dialog on the client. Pin that
       the auth path is never consulted. */
    const { loadAuthValues } = require('~/server/services/Tools/credentials');
    loadAuthValues.mockClear();

    await verifyToolAuth(makeReq(Tools.execute_code), makeRes());

    expect(loadAuthValues).not.toHaveBeenCalled();
  });

  it('does NOT reference AuthType.USER_PROVIDED in the response (Phase 8 removed the path)', async () => {
    const res = makeRes();
    await verifyToolAuth(makeReq(Tools.execute_code), res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.message).not.toBe(AuthType.USER_PROVIDED);
  });
});

describe('verifyToolAuth — web search selection contract', () => {
  const makeRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  it('returns the resolved provider selections with the auth state', async () => {
    loadWebSearchAuth.mockResolvedValue({
      authenticated: true,
      authTypes: {
        providers: AuthType.USER_PROVIDED,
        scrapers: AuthType.USER_PROVIDED,
        rerankers: AuthType.SYSTEM_DEFINED,
      },
      authResult: {
        searchProvider: 'keenable',
        scraperProvider: 'keenable',
        rerankerType: 'none',
      },
    });
    const req = {
      params: { toolId: Tools.web_search },
      user: { id: 'user-1' },
      config: { webSearch: {} },
    };
    const res = makeRes();

    await verifyToolAuth(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      authenticated: true,
      authTypes: {
        providers: AuthType.USER_PROVIDED,
        scrapers: AuthType.USER_PROVIDED,
        rerankers: AuthType.SYSTEM_DEFINED,
      },
      searchProvider: 'keenable',
      scraperProvider: 'keenable',
      rerankerType: 'none',
    });
  });
});
