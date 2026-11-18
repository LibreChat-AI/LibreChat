const { fetch: undiciFetch } = require('undici');
const { logger } = require('@librechat/data-schemas');
const TavilySearchResults = require('../TavilySearchResults');
const TraversaalSearch = require('../TraversaalSearch');
const GoogleSearch = require('../GoogleSearch');

jest.mock('undici', () => ({ ...jest.requireActual('undici'), fetch: jest.fn() }));

const SECRET = 'PRIVATE-PROVIDER-DETAIL';
const FALLBACK = 'Error: The tool request failed.';
const originalFetch = global.fetch;

const tools = [
  {
    service: 'Google Search',
    create: () =>
      new GoogleSearch({ GOOGLE_SEARCH_API_KEY: 'google-key', GOOGLE_CSE_ID: 'search-engine' }),
    transport: () => global.fetch,
    errorBody: { error: { message: SECRET } },
    success: { body: { items: [{ title: 'Paris' }] }, expected: '{"items":[{"title":"Paris"}]}' },
  },
  {
    service: 'Traversaal',
    create: () => new TraversaalSearch({ TRAVERSAAL_API_KEY: 'traversaal-key' }),
    transport: () => global.fetch,
    errorBody: { error: SECRET, message: SECRET },
    success: {
      body: { data: { response_text: 'Paris is sunny', web_url: ['https://example.com/paris'] } },
      expected: 'Paris is sunny\n\nSources:\n - https://example.com/paris',
    },
  },
  {
    service: 'Tavily',
    create: () => new TavilySearchResults({ TAVILY_API_KEY: 'tavily-key' }),
    transport: () => undiciFetch,
    errorBody: { detail: { error: SECRET }, error: SECRET },
    success: { body: { results: [] }, expected: '{"results":[]}' },
  },
];

/** True when any logged argument, including an error message, carries the text. */
const logged = (text) =>
  [logger.warn, logger.error, logger.info, logger.debug]
    .flatMap((method) => method.mock.calls.flat())
    .some((arg) => `${arg instanceof Error ? arg.message : JSON.stringify(arg)}`.includes(text));

beforeEach(() => {
  jest.restoreAllMocks();
  undiciFetch.mockReset();
  global.fetch = jest.fn();
  for (const method of ['warn', 'error', 'info', 'debug']) {
    jest.spyOn(logger, method).mockImplementation(() => logger);
  }
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe.each(tools)(
  '$service approved error text',
  ({ service, create, transport, errorBody, success }) => {
    const call = () => create()._call({ query: 'weather in Paris' });

    it('words a failing HTTP status from the status alone, never the provider body', async () => {
      transport().mockResolvedValue({
        ok: false,
        status: 403,
        json: jest.fn().mockResolvedValue(errorBody),
      });

      const result = await call();

      expect(result).toBe(`Error: ${service} rejected the configured credentials (status 403).`);
      expect(result).not.toContain(SECRET);
      expect(logger.warn).toHaveBeenCalledWith(`[${service}] Tool request failed`, {
        status: 403,
      });
      expect(logged(SECRET)).toBe(false);
    });

    it.each([
      ['a body that is not JSON', () => jest.fn().mockRejectedValue(new SyntaxError(SECRET))],
      ['a body without an error field', () => jest.fn().mockResolvedValue({})],
    ])('approves the status of a failing response with %s', async (_label, makeJson) => {
      transport().mockResolvedValue({ ok: false, status: 502, json: makeJson() });

      const result = await call();

      expect(result).toBe(`Error: ${service} is unavailable; try again later (status 502).`);
      expect(logged(SECRET)).toBe(false);
    });

    it('cancels the unread body of a failing response so its connection is released', async () => {
      const cancel = jest.fn().mockResolvedValue(undefined);
      const json = jest.fn();
      transport().mockResolvedValue({ ok: false, status: 500, body: { cancel }, json });

      await call();

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(json).not.toHaveBeenCalled();
    });

    it('returns the stable fallback for a transport failure and logs only its type', async () => {
      transport().mockRejectedValue(new Error(`connect ECONNREFUSED 10.0.0.5:443 ${SECRET}`));

      const result = await call();

      expect(result).toBe(FALLBACK);
      expect(logger.warn).toHaveBeenCalledWith(`[${service}] Tool request failed`, {
        type: 'Error',
      });
      expect(logged(SECRET)).toBe(false);
    });

    it('keeps returning the provider results on success', async () => {
      transport().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue(success.body),
      });

      await expect(call()).resolves.toBe(success.expected);
    });
  },
);

describe('Traversaal approved error text', () => {
  it('keeps its own guidance when the answer cannot be parsed', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const result = await new TraversaalSearch({ TRAVERSAAL_API_KEY: 'traversaal-key' })._call({
      query: 'weather in Paris',
    });

    expect(result).toBe('Error: Could not parse Traversaal API results. Please try again.');
  });
});
