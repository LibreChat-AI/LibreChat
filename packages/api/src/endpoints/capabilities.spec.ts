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

const req = { config: { endpoints: {} } } as unknown as ServerRequest;

describe('createReasoningCapabilitiesHandler', () => {
  it('returns the capabilities when every catalog was read', async () => {
    const capabilities = { OpenRouter: { 'a/b': { efforts: ['low'] } } };
    const handler = createReasoningCapabilitiesHandler({
      getReasoningCapabilities: async () => ({ capabilities, unavailable: [] }),
    });
    const res = makeRes();

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(capabilities);
  });

  it('passes the request config to the resolver', async () => {
    const getReasoningCapabilities = jest.fn(async () => ({ capabilities: {}, unavailable: [] }));

    await createReasoningCapabilitiesHandler({ getReasoningCapabilities })(req, makeRes());

    expect(getReasoningCapabilities).toHaveBeenCalledWith(req.config);
  });

  it('answers 503 with a stable code when a catalog is unavailable', async () => {
    const handler = createReasoningCapabilitiesHandler({
      getReasoningCapabilities: async () => ({ capabilities: {}, unavailable: ['OpenRouter'] }),
    });
    const res = makeRes();

    await handler(req, res);

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

    await handler(req, res);

    expect(JSON.stringify(res.json.mock.calls)).not.toContain('Internal Gateway');
  });

  it('answers 500 without the error text when resolution throws', async () => {
    const handler = createReasoningCapabilitiesHandler({
      getReasoningCapabilities: async () => {
        throw new Error('secret detail');
      },
    });
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret detail');
  });
});
