import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createReasoningCapabilitiesHandler } from './capabilities';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const makeRes = () => {
  const res = {} as Response & { status: jest.Mock; json: jest.Mock };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeReq = (query: Record<string, unknown> = { endpoint: 'OpenRouter' }) =>
  ({ config: { endpoints: {} }, query }) as unknown as ServerRequest;

describe('createReasoningCapabilitiesHandler', () => {
  it('returns the capabilities when the catalog was read', async () => {
    const capabilities = { OpenRouter: { 'a/b': { efforts: ['low'] } } };
    const handler = createReasoningCapabilitiesHandler({
      getReasoningCapabilities: async () => ({ capabilities, unavailable: [] }),
    });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ capabilities, expiresInMs: expect.any(Number) });
  });

  describe('expiry the client revalidates against', () => {
    const NOW = 1_000_000;
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });
    const respond = async (expiresAt: number | undefined) => {
      const res = makeRes();
      await createReasoningCapabilitiesHandler({
        getReasoningCapabilities: async () => ({ capabilities: {}, unavailable: [], expiresAt }),
      })(makeReq(), res);
      return res.json.mock.calls[0][0].expiresInMs;
    };

    it('sends the time left in the server entry', async () => {
      expect(await respond(NOW + 42000)).toBe(42000);
    });

    it('never sends a negative time', async () => {
      expect(await respond(NOW - 5)).toBe(0);
    });

    it('sends five minutes when no entry applies, so the client still revalidates', async () => {
      expect(await respond(undefined)).toBe(300000);
    });
  });

  it('scopes the lookup to the requested endpoint and the request config', async () => {
    const getReasoningCapabilities = jest.fn(async () => ({ capabilities: {}, unavailable: [] }));
    const req = makeReq({ endpoint: 'My Gateway' });

    await createReasoningCapabilitiesHandler({ getReasoningCapabilities })(req, makeRes());

    expect(getReasoningCapabilities).toHaveBeenCalledWith(req.config, 'My Gateway');
  });

  it.each([{}, { endpoint: '' }, { endpoint: ['a', 'b'] }, { endpoint: 42 }])(
    'answers 400 when the endpoint query is %j',
    async (query) => {
      const getReasoningCapabilities = jest.fn();
      const res = makeRes();

      await createReasoningCapabilitiesHandler({ getReasoningCapabilities })(makeReq(query), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'endpoint_required' });
      expect(getReasoningCapabilities).not.toHaveBeenCalled();
    },
  );

  it('answers 503 with a stable code when the catalog is unavailable', async () => {
    const handler = createReasoningCapabilitiesHandler({
      getReasoningCapabilities: async () => ({ capabilities: {}, unavailable: ['OpenRouter'] }),
    });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'reasoning_catalog_unavailable' });
  });

  it('does not expose the unavailable endpoint names', async () => {
    const handler = createReasoningCapabilitiesHandler({
      getReasoningCapabilities: async () => ({
        capabilities: {},
        unavailable: ['Internal Gateway'],
      }),
    });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(JSON.stringify(res.json.mock.calls)).not.toContain('Internal Gateway');
  });

  it('answers 500 without the error text when resolution throws', async () => {
    const handler = createReasoningCapabilitiesHandler({
      getReasoningCapabilities: async () => {
        throw new Error('secret detail');
      },
    });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret detail');
  });
});
