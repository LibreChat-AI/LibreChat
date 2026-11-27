import { logger } from '@librechat/data-schemas';
import type { AppConfig, IUser, OIDCTokens } from '@librechat/data-schemas';
import type { Agent, TConversation } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { createOpenIDTokenRefresh } from './openid';
import { loadAddedAgent } from '~/agents/added';
import { resolveHeaders } from '~/utils/env';

const now = () => Math.floor(Date.now() / 1000);
const BEARER = { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' };
const FRESH: OIDCTokens = {
  access_token: 'fresh-access-token',
  id_token: 'fresh-id-token',
  refresh_token: 'rotated-refresh-token',
  expires_at: now() + 3600,
};

type Endpoints = NonNullable<AppConfig['endpoints']>;

function custom(name: string, headers?: Record<string, string>) {
  return {
    name,
    apiKey: 'key',
    baseURL: 'https://example.com/v1',
    models: { default: ['m'] },
    headers,
  };
}

/** A gateway that forwards the access token, and a plain endpoint that does not. */
const ENDPOINTS = {
  custom: [custom('gateway', BEARER), custom('plain', { 'X-Org': 'org' })],
} as Endpoints;

/** Azure routes each model to a group; only the east group forwards the access token. */
const AZURE = {
  azureOpenAI: {
    modelGroupMap: { 'gpt-east': { group: 'east' }, 'gpt-west': { group: 'west' } },
    groupMap: { east: { additionalHeaders: BEARER, models: {} }, west: { models: {} } },
  },
} as unknown as Endpoints;

function makeUser(tokens: OIDCTokens = { access_token: 'stale', expires_at: now() - 60 }): IUser {
  return {
    id: 'user-1',
    provider: 'openid',
    openidId: 'oidc-sub-1',
    federatedTokens: tokens,
  } as IUser;
}

function makeReq({
  user = makeUser(),
  endpoints = ENDPOINTS,
  provider = 'gateway',
  model = 'model',
  addedConvo,
  resolvedAddedAgent,
  authStrategy = 'openidJwt',
}: {
  user?: IUser;
  endpoints?: Endpoints;
  provider?: string;
  model?: string;
  addedConvo?: { endpoint?: string; model?: string; agent_id?: string; spec?: string };
  resolvedAddedAgent?: Pick<Agent, 'provider' | 'model'>;
  authStrategy?: string;
} = {}): ServerRequest {
  const agent = Promise.resolve({ id: 'agent-1', provider, model } as Agent);
  return {
    user,
    authStrategy,
    resolvedAddedAgent,
    config: { endpoints },
    body: { endpointOption: { agent, addedConvo } },
  } as unknown as ServerRequest;
}

/** A saved agent the access check did not cache, as it does not for administrators. */
const SAVED_AGENT = 'agent_saved';

function setup(
  result: () => Promise<OIDCTokens | null>,
  getAgent: (filter: { id: string }) => Promise<Agent | null> = async () => null,
) {
  const provider = jest.fn(result);
  const createOpenIDSessionTokenProvider = jest.fn(() => provider);
  const middleware = createOpenIDTokenRefresh({
    createOpenIDSessionTokenProvider,
    getAgent: jest.fn(getAgent),
  });
  const res = {} as Response;
  const run = async (req: ServerRequest) => {
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    return next.mock.calls[0][0] as unknown;
  };
  return { provider, createOpenIDSessionTokenProvider, res, run };
}

describe('createOpenIDTokenRefresh', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warn.mockRestore();
    delete process.env.GATEWAY_AUTHORIZATION;
  });

  it('refreshes an expired access token before the turn forwards it to its endpoint', async () => {
    const { run, res, createOpenIDSessionTokenProvider } = setup(async () => FRESH);
    const req = makeReq();
    expect(() => resolveHeaders({ headers: BEARER, user: req.user })).toThrow(
      OpenIDReauthRequiredError,
    );

    await expect(run(req)).resolves.toBeUndefined();

    expect(createOpenIDSessionTokenProvider).toHaveBeenCalledWith({
      req,
      res,
      user: req.user,
      tokenPreference: 'access_token',
    });
    expect(req.user?.federatedTokens).toEqual(FRESH);
    expect(resolveHeaders({ headers: BEARER, user: req.user, stripUnresolved: true })).toEqual({
      Authorization: 'Bearer fresh-access-token',
    });
  });

  it('keeps the stored ID and refresh tokens when the session returns only an access token', async () => {
    const { run } = setup(async () => ({ access_token: 'fresh', expires_at: now() + 600 }));
    const req = makeReq({
      user: makeUser({
        access_token: 'stale',
        id_token: 'stored-id-token',
        refresh_token: 'stored-refresh-token',
        expires_at: now() - 60,
      }),
    });

    await expect(run(req)).resolves.toBeUndefined();

    expect(req.user?.federatedTokens).toEqual({
      access_token: 'fresh',
      id_token: 'stored-id-token',
      refresh_token: 'stored-refresh-token',
      expires_at: expect.any(Number),
    });
  });

  it('refuses the turn with a 401 when the session can no longer refresh', async () => {
    const cause = new Error('refresh_token=secret-value rejected');
    const { run } = setup(async () => {
      throw cause;
    });
    const req = makeReq({ user: makeUser({ refresh_token: 'cookie-refresh-token' }) });

    const error = (await run(req)) as OpenIDReauthRequiredError;

    expect(error).toBeInstanceOf(OpenIDReauthRequiredError);
    expect(error.statusCode).toBe(401);
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('secret-value');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-value');
    expect(req.user?.federatedTokens).toEqual({ refresh_token: 'cookie-refresh-token' });
  });

  it('refuses the turn when the session has no access token to offer', async () => {
    const { run } = setup(async () => null);

    await expect(run(makeReq())).resolves.toBeInstanceOf(OpenIDReauthRequiredError);
  });

  it('refuses the turn when the session returns an access token that is already expired', async () => {
    const { run } = setup(async () => ({ access_token: 'expired', expires_at: now() - 5 }));

    await expect(run(makeReq())).resolves.toBeInstanceOf(OpenIDReauthRequiredError);
  });

  it('leaves a current access token alone', async () => {
    const { run, provider } = setup(async () => FRESH);
    const user = makeUser({ access_token: 'current', expires_at: now() + 600 });

    await expect(run(makeReq({ user }))).resolves.toBeUndefined();

    expect(provider).not.toHaveBeenCalled();
    expect(user.federatedTokens?.access_token).toBe('current');
  });

  it.each<[string, Parameters<typeof makeReq>[0]]>([
    ['the turn uses an endpoint that does not forward the access token', { provider: 'plain' }],
    ['the turn uses Bedrock, which sends no configured headers', { provider: 'bedrock' }],
    [
      'the Azure group of the turn model does not forward the token',
      { provider: 'azureOpenAI', model: 'gpt-west', endpoints: AZURE },
    ],
    [
      'only the ID token is forwarded',
      {
        endpoints: {
          custom: [custom('gateway', { 'X-Id': '{{LIBRECHAT_OPENID_ID_TOKEN}}' })],
        } as Endpoints,
      },
    ],
    [
      'shared headers forward the token but custom endpoints do not send them',
      { endpoints: { all: { headers: BEARER }, custom: [custom('gateway')] } as Endpoints },
    ],
    [
      'the endpoint overrides a shared header that forwards the token',
      {
        provider: 'openAI',
        endpoints: {
          all: { headers: BEARER },
          openAI: { headers: { authorization: 'Bearer static-gateway-key' } },
        } as Endpoints,
      },
    ],
    [
      'the custom endpoint takes its base URL from the user, so its headers are withheld',
      {
        endpoints: {
          custom: [{ ...custom('gateway', BEARER), baseURL: 'user_provided' }],
        } as Endpoints,
      },
    ],
    [
      "the added conversation's saved agent uses an endpoint that does not forward the token",
      {
        provider: 'plain',
        addedConvo: { agent_id: SAVED_AGENT },
        resolvedAddedAgent: { provider: 'plain', model: 'm' },
      },
    ],
    ['the request was not authenticated by OpenID token reuse', { authStrategy: 'jwt' }],
    ['no endpoint forwards the access token', { endpoints: { custom: [custom('gateway')] } }],
  ])('does not touch the session when %s', async (_label, options) => {
    const { run, createOpenIDSessionTokenProvider } = setup(async () => {
      throw new Error('the session must not be consulted');
    });

    await expect(run(makeReq(options))).resolves.toBeUndefined();

    expect(createOpenIDSessionTokenProvider).not.toHaveBeenCalled();
  });

  it.each<[string, Parameters<typeof makeReq>[0]]>([
    [
      'the generic token placeholder',
      { endpoints: { custom: [custom('gateway', { 'X-T': '{{LIBRECHAT_OPENID_TOKEN}}' })] } },
    ],
    [
      'an environment variable that holds the placeholder',
      {
        endpoints: {
          custom: [custom('gateway', { Authorization: '${GATEWAY_AUTHORIZATION}' })],
        } as Endpoints,
      },
    ],
    [
      'an Ollama endpoint configured under another case',
      { provider: 'ollama', endpoints: { custom: [custom('Ollama', BEARER)] } },
    ],
    [
      "the added conversation's saved agent, cached by the access check",
      {
        provider: 'plain',
        addedConvo: { agent_id: SAVED_AGENT },
        resolvedAddedAgent: { provider: 'gateway', model: 'm' },
      },
    ],
    [
      'the added conversation of a multi-response turn',
      { provider: 'plain', addedConvo: { endpoint: 'gateway' } },
    ],
    [
      'headers shared by the built-in endpoints',
      { provider: 'openAI', endpoints: { all: { headers: BEARER } } as Endpoints },
    ],
    [
      'the OpenAI endpoint',
      { provider: 'openAI', endpoints: { openAI: { headers: BEARER } } as Endpoints },
    ],
    [
      'a built-in endpoint',
      { provider: 'anthropic', endpoints: { anthropic: { headers: BEARER } } as Endpoints },
    ],
    [
      'the Azure group of the turn model',
      { provider: 'azureOpenAI', model: 'gpt-east', endpoints: AZURE },
    ],
  ])('refreshes when %s forwards the access token', async (_label, options) => {
    process.env.GATEWAY_AUTHORIZATION = 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}';
    const { run, provider } = setup(async () => FRESH);

    await expect(run(makeReq(options))).resolves.toBeUndefined();

    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('refreshes for the model an enforced spec gives the added conversation', async () => {
    const { run, provider } = setup(async () => FRESH);
    const req = makeReq({
      provider: 'plain',
      endpoints: { ...ENDPOINTS, ...AZURE } as Endpoints,
      addedConvo: { endpoint: 'azureOpenAI', model: 'gpt-west', spec: 'east' },
    });
    /** `loadAddedAgent` runs the preset's model, which the east group serves. */
    (req.config as AppConfig).modelSpecs = {
      enforce: true,
      list: [
        { name: 'east', label: 'East', preset: { endpoint: 'azureOpenAI', model: 'gpt-east' } },
      ],
    } as AppConfig['modelSpecs'];

    await expect(run(req)).resolves.toBeUndefined();

    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("reads the added conversation's saved agent once, for itself and the turn", async () => {
    const saved = { id: SAVED_AGENT, provider: 'gateway', model: 'm' } as Agent;
    const getAgent = jest.fn(async () => saved);
    const { run, provider } = setup(async () => FRESH, getAgent);
    const addedConvo = { agent_id: SAVED_AGENT };
    const req = makeReq({ provider: 'plain', addedConvo });

    await expect(run(req)).resolves.toBeUndefined();

    expect(getAgent).toHaveBeenCalledWith({ id: SAVED_AGENT });
    expect(provider).toHaveBeenCalledTimes(1);
    const turnRead = jest.fn(async () => null);
    /** The same request object, so the turn sees what the middleware cached on it. */
    const turnReq = req as unknown as Parameters<typeof loadAddedAgent>[0]['req'];
    const added = await loadAddedAgent(
      { req: turnReq, conversation: addedConvo as TConversation },
      { getAgent: turnRead, getMCPServerTools: jest.fn() },
    );
    expect(added?.provider).toBe('gateway');
    expect(turnRead).not.toHaveBeenCalled();
    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it('ends the request at the error handler when the added agent cannot be read', async () => {
    const failure = new Error('database unavailable');
    const getAgent = jest.fn(async () => {
      throw failure;
    });
    const { run, createOpenIDSessionTokenProvider } = setup(async () => FRESH, getAgent);
    const req = makeReq({ provider: 'plain', addedConvo: { agent_id: SAVED_AGENT } });

    await expect(run(req)).resolves.toBe(failure);

    expect(createOpenIDSessionTokenProvider).not.toHaveBeenCalled();
    expect(
      (req as ServerRequest & { resolvedAddedAgent?: Agent }).resolvedAddedAgent,
    ).toBeUndefined();
  });
});
