const dataSchemas = require('@librechat/data-schemas');
const { logger } = dataSchemas;
const { Constants, actionDelimiter, actionDomainSeparator } = require('librechat-data-provider');

const mockEmitChunk = jest.fn();
const mockFindToken = jest.fn();
const mockActionFlowManager = {
  createFlowWithHandler: jest.fn(),
  createFlow: jest.fn(),
};

jest.mock('keyv');

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'signed-state'),
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  sleep: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  validateActionOAuthMetadata: jest.fn().mockResolvedValue(undefined),
  GenerationJobManager: {
    emitChunk: (...args) => mockEmitChunk(...args),
  },
}));

jest.mock('~/models', () => ({
  getActions: jest.fn(),
  findToken: (...args) => mockFindToken(...args),
  updateToken: jest.fn(),
  createToken: jest.fn(),
  deleteActions: jest.fn(),
  deleteAssistant: jest.fn(),
}));

jest.mock('~/config', () => ({
  getActionFlowStateManager: jest.fn(() => mockActionFlowManager),
}));

const { getActions } = require('~/models');
const {
  createActionTool,
  domainParser,
  legacyDomainEncode,
  validateAndUpdateTool,
} = require('./ActionService');

let mockDomainCache = {};
jest.mock('~/cache/getLogStores', () => {
  return jest.fn().mockImplementation(() => ({
    get: async (key) => mockDomainCache[key] ?? null,
    set: async (key, value) => {
      mockDomainCache[key] = value;
      return true;
    },
  }));
});

beforeEach(() => {
  mockDomainCache = {};
  getActions.mockReset();
  mockEmitChunk.mockReset();
  mockFindToken.mockReset();
  mockActionFlowManager.createFlowWithHandler.mockReset();
  mockActionFlowManager.createFlow.mockReset();
});

const SEP = actionDomainSeparator;
const DELIM = actionDelimiter;
const MAX = Constants.ENCODED_DOMAIN_LENGTH;
const domainSepRegex = new RegExp(SEP, 'g');

describe('domainParser', () => {
  describe('nullish input', () => {
    it.each([null, undefined, ''])('returns undefined for %j', async (input) => {
      expect(await domainParser(input, true)).toBeUndefined();
      expect(await domainParser(input, false)).toBeUndefined();
    });
  });

  describe('short-path encoding (hostname ≤ threshold)', () => {
    it.each([
      ['examp.com', `examp${SEP}com`],
      ['swapi.tech', `swapi${SEP}tech`],
      ['a.b', `a${SEP}b`],
    ])('replaces dots in %s → %s', async (domain, expected) => {
      expect(await domainParser(domain, true)).toBe(expected);
    });

    it('handles domain exactly at threshold length', async () => {
      const domain = 'a'.repeat(MAX - 4) + '.com';
      expect(domain).toHaveLength(MAX);
      const result = await domainParser(domain, true);
      expect(result).toBe(domain.replace(/\./g, SEP));
    });
  });

  describe('base64-path encoding (hostname > threshold)', () => {
    it('produces a key of exactly ENCODED_DOMAIN_LENGTH chars', async () => {
      const result = await domainParser('api.example.com', true);
      expect(result).toHaveLength(MAX);
    });

    it('encodes hostname, not full URL', async () => {
      const hostname = 'api.example.com';
      const expectedKey = Buffer.from(hostname).toString('base64').substring(0, MAX);
      expect(await domainParser(hostname, true)).toBe(expectedKey);
    });

    it('populates decode cache for round-trip', async () => {
      const hostname = 'longdomainname.com';
      const key = await domainParser(hostname, true);

      expect(mockDomainCache[key]).toBe(Buffer.from(hostname).toString('base64'));
      expect(await domainParser(key, false)).toBe(hostname);
    });
  });

  describe('protocol stripping', () => {
    it('https:// URL and bare hostname produce identical encoding', async () => {
      const encoded = await domainParser('https://swapi.tech', true);
      expect(encoded).toBe(await domainParser('swapi.tech', true));
      expect(encoded).toBe(`swapi${SEP}tech`);
    });

    it('http:// URL and bare hostname produce identical encoding', async () => {
      const encoded = await domainParser('http://api.example.com', true);
      expect(encoded).toBe(await domainParser('api.example.com', true));
    });

    it('different https:// domains produce unique keys', async () => {
      const keys = await Promise.all([
        domainParser('https://api.example.com', true),
        domainParser('https://api.weather.com', true),
        domainParser('https://data.github.com', true),
      ]);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    });

    it('long hostname after stripping still uses base64 path', async () => {
      const result = await domainParser('https://api.example.com', true);
      expect(result).toHaveLength(MAX);
      expect(result).not.toContain(SEP);
    });

    it('short hostname after stripping uses dot-replacement path', async () => {
      const result = await domainParser('https://a.b.c', true);
      expect(result).toBe(`a${SEP}b${SEP}c`);
    });

    it('strips path and query from full URL before encoding', async () => {
      const result = await domainParser('https://api.example.com/v1/endpoint?foo=bar', true);
      expect(result).toBe(await domainParser('api.example.com', true));
    });
  });

  describe('unicode domains', () => {
    it('encodes unicode hostname via base64 path', async () => {
      const domain = 'täst.example.com';
      const result = await domainParser(domain, true);
      expect(result).toHaveLength(MAX);
      expect(result).toBe(Buffer.from(domain).toString('base64').substring(0, MAX));
    });

    it('round-trips unicode hostname through encode then decode', async () => {
      const domain = 'täst.example.com';
      const key = await domainParser(domain, true);
      expect(await domainParser(key, false)).toBe(domain);
    });

    it('strips protocol before encoding unicode hostname', async () => {
      const withProto = 'https://täst.example.com';
      const bare = 'täst.example.com';
      expect(await domainParser(withProto, true)).toBe(await domainParser(bare, true));
    });
  });

  describe('decode path', () => {
    it('short-path encoded domain decodes via separator replacement', async () => {
      expect(await domainParser(`examp${SEP}com`, false)).toBe('examp.com');
    });

    it('base64-path encoded domain decodes via cache lookup', async () => {
      const hostname = 'api.example.com';
      const key = await domainParser(hostname, true);
      expect(await domainParser(key, false)).toBe(hostname);
    });

    it('returns input unchanged for unknown non-separator strings', async () => {
      expect(await domainParser('not_base64_encoded', false)).toBe('not_base64_encoded');
    });

    it('returns a string without throwing for corrupt cache entries', async () => {
      mockDomainCache['corrupt_key'] = '!!!';
      const result = await domainParser('corrupt_key', false);
      expect(typeof result).toBe('string');
    });
  });
});

describe('legacyDomainEncode', () => {
  it.each(['', null, undefined])('returns empty string for %j', (input) => {
    expect(legacyDomainEncode(input)).toBe('');
  });

  it('is synchronous (returns a string, not a Promise)', () => {
    const result = legacyDomainEncode('examp.com');
    expect(result).toBe(`examp${SEP}com`);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('uses dot-replacement for short domains', () => {
    expect(legacyDomainEncode('examp.com')).toBe(`examp${SEP}com`);
  });

  it('uses base64 prefix of full input for long domains', () => {
    const domain = 'https://swapi.tech';
    const expected = Buffer.from(domain).toString('base64').substring(0, MAX);
    expect(legacyDomainEncode(domain)).toBe(expected);
  });

  it('all https:// URLs collide to the same key', () => {
    const results = [
      legacyDomainEncode('https://api.example.com'),
      legacyDomainEncode('https://api.weather.com'),
      legacyDomainEncode('https://totally.different.host'),
    ];
    expect(new Set(results).size).toBe(1);
  });

  it('matches what old domainParser would have produced', () => {
    const domain = 'https://api.example.com';
    const legacy = legacyDomainEncode(domain);
    expect(legacy).toBe(Buffer.from(domain).toString('base64').substring(0, MAX));
  });

  it('produces same result as new domainParser for short bare hostnames', async () => {
    const domain = 'swapi.tech';
    expect(legacyDomainEncode(domain)).toBe(await domainParser(domain, true));
  });
});

describe('createActionTool OAuth events', () => {
  it('fences resumable login and completion deltas to the owning job epoch', async () => {
    const streamId = 'action-oauth-stream';
    const jobCreatedAt = 1234;
    const preparedExecutor = {
      setAuth: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockResolvedValue({ data: { ok: true } }),
    };
    const requestBuilder = {
      createExecutor: jest.fn(() => ({
        setParams: jest.fn(() => preparedExecutor),
      })),
    };
    mockFindToken.mockResolvedValue(null);
    mockActionFlowManager.createFlowWithHandler.mockImplementation(
      async (_flowId, _type, handler) => handler(),
    );
    mockActionFlowManager.createFlow.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    });

    const actionTool = await createActionTool({
      userId: 'action-user',
      res: {},
      action: {
        action_id: 'action-1',
        metadata: {
          domain: 'https://api.example.com',
          oauth_client_id: 'client-id',
          auth: {
            type: 'oauth',
            authorization_url: 'https://auth.example.com/authorize',
            client_url: 'https://auth.example.com/token',
            scope: 'read',
          },
        },
      },
      requestBuilder,
      encrypted: {
        oauth_client_id: 'encrypted-client-id',
        oauth_client_secret: 'encrypted-client-secret',
      },
      streamId,
      jobCreatedAt,
    });

    await actionTool._call(
      {},
      {
        metadata: {
          thread_id: 'thread-1',
          run_id: 'run-1',
        },
        toolCall: {
          id: 'tool-call-1',
          stepId: 'step-1',
          name: 'action-tool',
          type: 'tool_call',
        },
      },
    );

    expect(mockEmitChunk).toHaveBeenCalledTimes(2);
    for (const [emittedStreamId, , options] of mockEmitChunk.mock.calls) {
      expect(emittedStreamId).toBe(streamId);
      expect(options).toEqual({ expectedCreatedAt: jobCreatedAt });
    }
  });
});

describe('createActionTool OAuth flow cancellation', () => {
  /**
   * `monitorFlow` deletes the flow key when a waiter's signal aborts. The
   * authorization and refresh flows are keyed `userId:action_id`, so a second
   * run for the same action joins the very same record and the browser's OAuth
   * callback reads its metadata to exchange the code — one Stop must not strand
   * either of them. Only the run-scoped login flow may carry the run signal.
   */
  it('withholds the run signal from flows shared beyond this run', async () => {
    const preparedExecutor = {
      setAuth: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockResolvedValue({ data: { ok: true } }),
    };
    const requestBuilder = {
      createExecutor: jest.fn(() => ({
        setParams: jest.fn(() => preparedExecutor),
      })),
    };
    mockFindToken.mockResolvedValue(null);
    mockActionFlowManager.createFlowWithHandler.mockImplementation(
      async (_flowId, _type, handler) => handler(),
    );
    mockActionFlowManager.createFlow.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    });

    const actionTool = await createActionTool({
      userId: 'action-user',
      res: {},
      action: {
        action_id: 'action-1',
        metadata: {
          domain: 'https://api.example.com',
          oauth_client_id: 'client-id',
          auth: {
            type: 'oauth',
            authorization_url: 'https://auth.example.com/authorize',
            client_url: 'https://auth.example.com/token',
            scope: 'read',
          },
        },
      },
      requestBuilder,
      encrypted: {
        oauth_client_id: 'encrypted-client-id',
        oauth_client_secret: 'encrypted-client-secret',
      },
      streamId: 'action-oauth-stream',
      jobCreatedAt: 1234,
    });

    const signal = new AbortController().signal;
    await actionTool._call(
      {},
      {
        signal,
        metadata: { thread_id: 'thread-1', run_id: 'run-1' },
        toolCall: {
          id: 'tool-call-1',
          stepId: 'step-1',
          name: 'action-tool',
          type: 'tool_call',
        },
      },
    );

    const [sharedFlowId, sharedType, , sharedSignal] =
      mockActionFlowManager.createFlow.mock.calls[0];
    expect(sharedFlowId).toBe('action-user:action-1');
    expect(sharedType).toBe('oauth');
    expect(sharedSignal).toBeUndefined();

    const loginCall = mockActionFlowManager.createFlowWithHandler.mock.calls.find(
      ([, type]) => type === 'oauth_login',
    );
    expect(loginCall[0]).toBe('action-user:action-1:oauth_login:thread-1:run-1');
    expect(loginCall[3]).toBe(signal);
  });
});

describe('createActionTool OAuth stop behavior', () => {
  /**
   * Detaching is not the same as ignoring the Stop: the shared flow survives for
   * other waiters and the browser callback, but a late authorization must not
   * resume this call into the API request it was gating.
   */
  it('does not run the API request when the run is stopped mid-OAuth', async () => {
    const preparedExecutor = {
      setAuth: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockResolvedValue({ data: { ok: true } }),
    };
    const requestBuilder = {
      createExecutor: jest.fn(() => ({
        setParams: jest.fn(() => preparedExecutor),
      })),
    };
    mockFindToken.mockResolvedValue(null);
    mockActionFlowManager.createFlowWithHandler.mockImplementation(
      async (_flowId, _type, handler) => handler(),
    );

    /** The shared flow completes only after the user has pressed Stop, exactly
     *  as it would when the browser callback lands late. */
    let completeFlow;
    mockActionFlowManager.createFlow.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeFlow = resolve;
        }),
    );

    const actionTool = await createActionTool({
      userId: 'action-user',
      res: {},
      action: {
        action_id: 'action-1',
        metadata: {
          domain: 'https://api.example.com',
          oauth_client_id: 'client-id',
          auth: {
            type: 'oauth',
            authorization_url: 'https://auth.example.com/authorize',
            client_url: 'https://auth.example.com/token',
            scope: 'read',
          },
        },
      },
      requestBuilder,
      encrypted: {
        oauth_client_id: 'encrypted-client-id',
        oauth_client_secret: 'encrypted-client-secret',
      },
      streamId: 'action-oauth-stream',
      jobCreatedAt: 1234,
    });

    const controller = new AbortController();
    const call = actionTool._call(
      {},
      {
        signal: controller.signal,
        metadata: { thread_id: 'thread-1', run_id: 'run-1' },
        toolCall: {
          id: 'tool-call-1',
          stepId: 'step-1',
          name: 'action-tool',
          type: 'tool_call',
        },
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(call).rejects.toThrow();

    completeFlow({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(preparedExecutor.execute).not.toHaveBeenCalled();
  });
});

describe('createActionTool OAuth abort identity', () => {
  const oauthAction = {
    action_id: 'action-1',
    metadata: {
      domain: 'https://api.example.com',
      oauth_client_id: 'client-id',
      auth: {
        type: 'oauth',
        authorization_url: 'https://auth.example.com/authorize',
        client_url: 'https://auth.example.com/token',
        scope: 'read',
      },
    },
  };

  function oauthToolFixture() {
    const preparedExecutor = {
      setAuth: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockResolvedValue({ data: { ok: true } }),
    };
    return {
      preparedExecutor,
      requestBuilder: {
        createExecutor: jest.fn(() => ({
          setParams: jest.fn(() => preparedExecutor),
        })),
      },
    };
  }

  function callConfig(signal) {
    return {
      signal,
      metadata: { thread_id: 'thread-1', run_id: 'run-1' },
      toolCall: { id: 'tool-call-1', stepId: 'step-1', name: 'action-tool', type: 'tool_call' },
    };
  }

  it('does not request a fresh login when a stopped run detaches from a refresh', async () => {
    const { requestBuilder, preparedExecutor } = oauthToolFixture();
    /** No access token but a live refresh token: the branch that waits on the
     *  shared refresh flow rather than opening a login. */
    mockFindToken.mockImplementation(async ({ type }) =>
      type === 'oauth_refresh' ? { token: 'encrypted-refresh-token' } : null,
    );
    jest.spyOn(dataSchemas, 'decryptV2').mockResolvedValue('refresh-token');

    /** The refresh never settles; the run stops while it is pending. */
    mockActionFlowManager.createFlowWithHandler.mockImplementation(() => new Promise(() => {}));
    mockActionFlowManager.createFlow.mockImplementation(() => new Promise(() => {}));

    const actionTool = await createActionTool({
      userId: 'action-user',
      res: {},
      action: oauthAction,
      requestBuilder,
      encrypted: {
        oauth_client_id: 'encrypted-client-id',
        oauth_client_secret: 'encrypted-client-secret',
      },
    });

    const controller = new AbortController();
    const call = actionTool._call({}, callConfig(controller.signal));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(call).rejects.toThrow();

    const loginFlows = mockActionFlowManager.createFlowWithHandler.mock.calls.filter(
      ([, type]) => type === 'oauth_login',
    );
    expect(loginFlows).toHaveLength(0);
    expect(mockEmitChunk).not.toHaveBeenCalled();
    expect(preparedExecutor.execute).not.toHaveBeenCalled();
  });

  it('propagates the abort instead of reporting a failed API call', async () => {
    const { requestBuilder } = oauthToolFixture();
    mockFindToken.mockResolvedValue(null);
    mockActionFlowManager.createFlowWithHandler.mockImplementation(
      async (_flowId, _type, handler) => handler(),
    );
    mockActionFlowManager.createFlow.mockImplementation(() => new Promise(() => {}));

    const actionTool = await createActionTool({
      userId: 'action-user',
      res: {},
      action: oauthAction,
      requestBuilder,
      encrypted: {
        oauth_client_id: 'encrypted-client-id',
        oauth_client_secret: 'encrypted-client-secret',
      },
      streamId: 'action-oauth-stream',
      jobCreatedAt: 1234,
    });

    const controller = new AbortController();
    const call = actionTool._call({}, callConfig(controller.signal));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(call).rejects.toBe(controller.signal.reason);
    expect(logger.error).not.toHaveBeenCalledWith(
      'Failed to authenticate OAuth tool',
      expect.anything(),
    );
  });
});

describe('validateAndUpdateTool', () => {
  const mockReq = { user: { id: 'user123' } };

  it('returns tool unchanged when name passes tool-name regex', async () => {
    const tool = { function: { name: 'getPeople_action_swapi---tech' } };
    const result = await validateAndUpdateTool({
      req: mockReq,
      tool,
      assistant_id: 'asst_1',
    });
    expect(result).toEqual(tool);
    expect(getActions).not.toHaveBeenCalled();
  });

  it('matches action when metadata.domain has https:// prefix and tool domain is bare hostname', async () => {
    getActions.mockResolvedValue([{ metadata: { domain: 'https://api.example.com' } }]);

    const tool = { function: { name: `getPeople${DELIM}api.example.com` } };
    const result = await validateAndUpdateTool({
      req: mockReq,
      tool,
      assistant_id: 'asst_1',
    });

    expect(result).not.toBeNull();
    expect(result.function.name).toMatch(/^getPeople_action_/);
    expect(result.function.name).not.toContain('.');
  });

  it('matches action when metadata.domain has no protocol', async () => {
    getActions.mockResolvedValue([{ metadata: { domain: 'api.example.com' } }]);

    const tool = { function: { name: `getPeople${DELIM}api.example.com` } };
    const result = await validateAndUpdateTool({
      req: mockReq,
      tool,
      assistant_id: 'asst_1',
    });

    expect(result).not.toBeNull();
    expect(result.function.name).toMatch(/^getPeople_action_/);
  });

  it('returns null when no action matches the domain', async () => {
    getActions.mockResolvedValue([{ metadata: { domain: 'https://other.domain.com' } }]);

    const tool = { function: { name: `getPeople${DELIM}api.example.com` } };
    const result = await validateAndUpdateTool({
      req: mockReq,
      tool,
      assistant_id: 'asst_1',
    });

    expect(result).toBeNull();
  });

  it('returns null when action has no metadata', async () => {
    getActions.mockResolvedValue([{ metadata: null }]);

    const tool = { function: { name: `getPeople${DELIM}api.example.com` } };
    const result = await validateAndUpdateTool({
      req: mockReq,
      tool,
      assistant_id: 'asst_1',
    });

    expect(result).toBeNull();
  });
});

describe('backward-compatible tool name matching', () => {
  function normalizeToolName(name) {
    return name.replace(domainSepRegex, '_');
  }

  function buildToolName(functionName, encodedDomain) {
    return `${functionName}${DELIM}${encodedDomain}`;
  }

  describe('definition-phase matching', () => {
    it('new encoding matches agent tools stored with new encoding', async () => {
      const metadataDomain = 'https://swapi.tech';
      const encoded = await domainParser(metadataDomain, true);
      const normalized = normalizeToolName(encoded);

      const storedTool = buildToolName('getPeople', encoded);
      const defToolName = `getPeople${DELIM}${normalized}`;

      expect(normalizeToolName(storedTool)).toBe(defToolName);
    });

    it('legacy encoding matches agent tools stored with legacy encoding', async () => {
      const metadataDomain = 'https://swapi.tech';
      const legacy = legacyDomainEncode(metadataDomain);
      const legacyNormalized = normalizeToolName(legacy);

      const storedTool = buildToolName('getPeople', legacy);
      const legacyDefName = `getPeople${DELIM}${legacyNormalized}`;

      expect(normalizeToolName(storedTool)).toBe(legacyDefName);
    });

    it('new definition matches old stored tools via legacy fallback', async () => {
      const metadataDomain = 'https://swapi.tech';
      const newDomain = await domainParser(metadataDomain, true);
      const legacyDomain = legacyDomainEncode(metadataDomain);
      const newNorm = normalizeToolName(newDomain);
      const legacyNorm = normalizeToolName(legacyDomain);

      const oldStoredTool = buildToolName('getPeople', legacyDomain);
      const newToolName = `getPeople${DELIM}${newNorm}`;
      const legacyToolName = `getPeople${DELIM}${legacyNorm}`;

      const storedNormalized = normalizeToolName(oldStoredTool);
      const hasMatch = storedNormalized === newToolName || storedNormalized === legacyToolName;
      expect(hasMatch).toBe(true);
    });

    it('pre-normalized Set eliminates per-tool normalization', async () => {
      const metadataDomain = 'https://api.example.com';
      const domain = await domainParser(metadataDomain, true);
      const legacyDomain = legacyDomainEncode(metadataDomain);
      const normalizedDomain = normalizeToolName(domain);
      const legacyNormalized = normalizeToolName(legacyDomain);

      const storedTools = [
        buildToolName('getWeather', legacyDomain),
        buildToolName('getForecast', domain),
      ];

      const preNormalized = new Set(storedTools.map((t) => normalizeToolName(t)));

      const toolName = `getWeather${DELIM}${normalizedDomain}`;
      const legacyToolName = `getWeather${DELIM}${legacyNormalized}`;
      expect(preNormalized.has(toolName) || preNormalized.has(legacyToolName)).toBe(true);
    });
  });

  describe('execution-phase tool lookup', () => {
    it('model-called tool name resolves via normalizedToDomain map (new encoding)', async () => {
      const metadataDomain = 'https://api.example.com';
      const domain = await domainParser(metadataDomain, true);
      const normalized = normalizeToolName(domain);

      const normalizedToDomain = new Map();
      normalizedToDomain.set(normalized, domain);

      const modelToolName = `getWeather${DELIM}${normalized}`;

      let matched = '';
      for (const [norm, canonical] of normalizedToDomain.entries()) {
        if (modelToolName.includes(norm)) {
          matched = canonical;
          break;
        }
      }

      expect(matched).toBe(domain);

      const functionName = modelToolName.replace(`${DELIM}${normalizeToolName(matched)}`, '');
      expect(functionName).toBe('getWeather');
    });

    it('model-called tool name resolves via legacy entry in normalizedToDomain map', async () => {
      const metadataDomain = 'https://api.example.com';
      const domain = await domainParser(metadataDomain, true);
      const legacyDomain = legacyDomainEncode(metadataDomain);
      const legacyNorm = normalizeToolName(legacyDomain);

      const normalizedToDomain = new Map();
      normalizedToDomain.set(normalizeToolName(domain), domain);
      normalizedToDomain.set(legacyNorm, domain);

      const legacyModelToolName = `getWeather${DELIM}${legacyNorm}`;

      let matched = '';
      for (const [norm, canonical] of normalizedToDomain.entries()) {
        if (legacyModelToolName.includes(norm)) {
          matched = canonical;
          break;
        }
      }

      expect(matched).toBe(domain);
    });

    it('legacy guard skips duplicate map entry for short bare hostnames', async () => {
      const domain = 'swapi.tech';
      const newEncoding = await domainParser(domain, true);
      const legacyEncoding = legacyDomainEncode(domain);

      expect(newEncoding).toBe(legacyEncoding);

      const normalizedToDomain = new Map();
      normalizedToDomain.set(newEncoding, newEncoding);
      if (legacyEncoding !== newEncoding) {
        normalizedToDomain.set(legacyEncoding, newEncoding);
      }
      expect(normalizedToDomain.size).toBe(1);
    });
  });

  describe('processRequiredActions matching (assistants path)', () => {
    it('legacy tool from OpenAI matches via normalizedToDomain with both encodings', async () => {
      const metadataDomain = 'https://swapi.tech';
      const domain = await domainParser(metadataDomain, true);
      const legacyDomain = legacyDomainEncode(metadataDomain);

      const normalizedToDomain = new Map();
      normalizedToDomain.set(domain, domain);
      if (legacyDomain !== domain) {
        normalizedToDomain.set(legacyDomain, domain);
      }

      const legacyToolName = buildToolName('getPeople', legacyDomain);

      let currentDomain = '';
      let matchedKey = '';
      for (const [key, canonical] of normalizedToDomain.entries()) {
        if (legacyToolName.includes(key)) {
          currentDomain = canonical;
          matchedKey = key;
          break;
        }
      }

      expect(currentDomain).toBe(domain);
      expect(matchedKey).toBe(legacyDomain);

      const functionName = legacyToolName.replace(`${DELIM}${matchedKey}`, '');
      expect(functionName).toBe('getPeople');
    });

    it('new tool name matches via the canonical domain key', async () => {
      const metadataDomain = 'https://swapi.tech';
      const domain = await domainParser(metadataDomain, true);
      const legacyDomain = legacyDomainEncode(metadataDomain);

      const normalizedToDomain = new Map();
      normalizedToDomain.set(domain, domain);
      if (legacyDomain !== domain) {
        normalizedToDomain.set(legacyDomain, domain);
      }

      const newToolName = buildToolName('getPeople', domain);

      let currentDomain = '';
      let matchedKey = '';
      for (const [key, canonical] of normalizedToDomain.entries()) {
        if (newToolName.includes(key)) {
          currentDomain = canonical;
          matchedKey = key;
          break;
        }
      }

      expect(currentDomain).toBe(domain);
      expect(matchedKey).toBe(domain);

      const functionName = newToolName.replace(`${DELIM}${matchedKey}`, '');
      expect(functionName).toBe('getPeople');
    });
  });

  describe('save-route cleanup', () => {
    it('tool filter removes tools matching new encoding', async () => {
      const metadataDomain = 'https://swapi.tech';
      const domain = await domainParser(metadataDomain, true);
      const legacyDomain = legacyDomainEncode(metadataDomain);

      const tools = [
        buildToolName('getPeople', domain),
        buildToolName('unrelated', 'other---domain'),
      ];

      const filtered = tools.filter((t) => !t.includes(domain) && !t.includes(legacyDomain));

      expect(filtered).toEqual([buildToolName('unrelated', 'other---domain')]);
    });

    it('tool filter removes tools matching legacy encoding', async () => {
      const metadataDomain = 'https://swapi.tech';
      const domain = await domainParser(metadataDomain, true);
      const legacyDomain = legacyDomainEncode(metadataDomain);

      const tools = [
        buildToolName('getPeople', legacyDomain),
        buildToolName('unrelated', 'other---domain'),
      ];

      const filtered = tools.filter((t) => !t.includes(domain) && !t.includes(legacyDomain));

      expect(filtered).toEqual([buildToolName('unrelated', 'other---domain')]);
    });
  });

  describe('delete-route domain extraction', () => {
    it('domain extracted from actions array is usable as-is for tool filtering', async () => {
      const metadataDomain = 'https://api.example.com';
      const domain = await domainParser(metadataDomain, true);
      const actionId = 'abc123';
      const actionEntry = `${domain}${DELIM}${actionId}`;

      const [storedDomain] = actionEntry.split(DELIM);
      expect(storedDomain).toBe(domain);

      const tools = [buildToolName('getWeather', domain), buildToolName('getPeople', 'other')];

      const filtered = tools.filter((t) => !t.includes(storedDomain));
      expect(filtered).toEqual([buildToolName('getPeople', 'other')]);
    });
  });

  describe('multi-action agents (collision scenario)', () => {
    it('two https:// actions now produce distinct tool names', async () => {
      const domain1 = await domainParser('https://api.weather.com', true);
      const domain2 = await domainParser('https://api.spacex.com', true);

      const tool1 = buildToolName('getData', domain1);
      const tool2 = buildToolName('getData', domain2);

      expect(tool1).not.toBe(tool2);
    });

    it('two https:// actions used to collide in legacy encoding', () => {
      const legacy1 = legacyDomainEncode('https://api.weather.com');
      const legacy2 = legacyDomainEncode('https://api.spacex.com');

      const tool1 = buildToolName('getData', legacy1);
      const tool2 = buildToolName('getData', legacy2);

      expect(tool1).toBe(tool2);
    });
  });
});
