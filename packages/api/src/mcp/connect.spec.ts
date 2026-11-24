import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import type { MCPReinitializeDependencies } from './connect';
import { createMCPReinitializeHandler } from './connect';

function setup() {
  const reinitialize = jest.fn().mockResolvedValue({
    success: true,
    message: 'Connected',
    serverName: 'server',
    oauthRequired: false,
  });
  const invalidate = jest.fn().mockResolvedValue('connect-generation');
  const disconnect = jest.fn().mockResolvedValue(undefined);
  const dependencies: MCPReinitializeDependencies = {
    oauthHandlingTimeout: 12345,
    getOAuthFlowId: (userId, serverName) => `injected-${userId}-${serverName}`,
    getMCPManager: () => ({ disconnectUserConnection: disconnect }),
    getMCPServersRegistry: () => ({
      recoverServerConfig: jest.fn(),
      getServerConfig: jest.fn().mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.test',
        requiresOAuth: false,
      }),
    }),
    resolveConfigServers: async () => undefined,
    invalidateCachedTools: invalidate,
    db: { findPluginAuthsByKeys: jest.fn().mockResolvedValue([]) },
    getTenantId: () => 'tenant',
    createOpenIDSessionTokenProvider: () => async () => null,
    reinitMCPServer: reinitialize,
  };
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: 'user', role: 'USER' } });
    next();
  });
  app.post('/:serverName/reinitialize', createMCPReinitializeHandler(dependencies));
  return { app, dependencies, reinitialize, invalidate, disconnect };
}

const originalSecret = process.env.JWT_SECRET;
beforeAll(() => {
  process.env.JWT_SECRET = 'synthetic-test-secret';
});
afterAll(() => {
  if (originalSecret == null) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

describe('Connect response ownership', () => {
  it('returns the operation outcome and invalidated generation without another shared write', async () => {
    const fixture = setup();
    const response = await request(fixture.app).post('/server/reinitialize').expect(200);
    expect(response.body).toMatchObject({
      success: true,
      message: 'Connected',
      serverName: 'server',
      oauthRequired: false,
      authorizationGeneration: 'connect-generation',
    });
    expect(fixture.invalidate).toHaveBeenCalledTimes(1);
    expect(fixture.disconnect).toHaveBeenCalledWith('user', 'server');
    expect(fixture.reinitialize).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal), forceNew: true }),
    );
  });
  it('returns confirmed failure without treating the HTTP 200 as successful Connect', async () => {
    const fixture = setup();
    fixture.reinitialize.mockResolvedValueOnce({
      success: false,
      message: 'Failed',
      serverName: 'server',
      oauthRequired: false,
      failureReason: 'initialization_failed',
    });
    const response = await request(fixture.app).post('/server/reinitialize').expect(200);
    expect(response.body).toMatchObject({ success: false, failureReason: 'initialization_failed' });
  });
  it('preserves OAuth URL, flow identifier, cookie and timeout', async () => {
    const fixture = setup();
    fixture.reinitialize.mockResolvedValueOnce({
      success: true,
      message: 'OAuth',
      serverName: 'server',
      oauthRequired: true,
      oauthUrl: 'https://auth.example.test',
      oauthExpiresAt: Date.now() + 60000,
    });
    const response = await request(fixture.app).post('/server/reinitialize').expect(200);
    expect(response.body).toMatchObject({
      oauthRequired: true,
      oauthUrl: 'https://auth.example.test',
    });
    expect(response.body.flowId).toBe('injected-user-server');
    expect(response.body.oauthTimeout).toBeGreaterThan(0);
    expect(response.headers['set-cookie']).toBeDefined();
  });
  it('sanitizes unexpected failures at the HTTP boundary', async () => {
    const fixture = setup();
    fixture.reinitialize.mockRejectedValueOnce(new Error('secret-token'));
    const response = await request(fixture.app).post('/server/reinitialize').expect(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});

it('uses the injected OAuth timeout independently for each handler', async () => {
  const fixture = setup();
  fixture.reinitialize.mockResolvedValue({
    success: true,
    serverName: 'server',
    oauthRequired: true,
    oauthUrl: 'https://auth.example.test',
  });
  const response = await request(fixture.app).post('/server/reinitialize').expect(200);
  expect(response.body.oauthTimeout).toBe(12345);
});

it('reports the recovered configuration revision actually used by Connect', async () => {
  const fixture = setup();
  const stub = {
    type: 'streamable-http' as const,
    url: 'https://mcp.example.test',
    updatedAt: 100,
    inspectionFailed: true,
  };
  const recovered = { ...stub, updatedAt: 200, inspectionFailed: false };
  fixture.dependencies.getMCPServersRegistry = () => ({
    getServerConfig: jest.fn().mockResolvedValue(stub),
    recoverServerConfig: jest.fn().mockResolvedValue(recovered),
  });
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: 'user', role: 'USER' } });
    next();
  });
  app.post('/:serverName/reinitialize', createMCPReinitializeHandler(fixture.dependencies));
  const response = await request(app).post('/server/reinitialize').expect(200);
  expect(response.body.configurationUpdatedAt).toBe(200);
  expect(fixture.reinitialize).toHaveBeenCalledWith(
    expect.objectContaining({ serverConfig: recovered }),
  );
});

function ownedResponse() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  });
}

async function invokeHandler(
  dependencies: MCPReinitializeDependencies,
  res: ReturnType<typeof ownedResponse>,
) {
  const handler = createMCPReinitializeHandler(dependencies);
  await handler(
    {
      params: { serverName: 'server' },
      user: { id: 'user', role: 'USER' },
    } as unknown as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1],
    jest.fn(),
  );
}

it.each(['destroyed', 'writableEnded'] as const)(
  'does not start work for an already %s response',
  async (state) => {
    const fixture = setup();
    const res = ownedResponse();
    res[state] = true;
    await invokeHandler(fixture.dependencies, res);
    expect(fixture.invalidate).not.toHaveBeenCalled();
    expect(fixture.reinitialize).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  },
);

it.each(['configuration', 'recovery', 'credentials'] as const)(
  'does not initialize after the owner disconnects during %s lookup',
  async (stage) => {
    const fixture = setup();
    const res = ownedResponse();
    const closeOwner = () => {
      res.destroyed = true;
      res.emit('close');
    };
    if (stage === 'configuration') {
      fixture.dependencies.resolveConfigServers = async () => {
        closeOwner();
        return undefined;
      };
    } else if (stage === 'recovery') {
      fixture.dependencies.getMCPServersRegistry = () => ({
        getServerConfig: jest.fn().mockResolvedValue({
          type: 'streamable-http',
          url: 'https://mcp.example.test',
          inspectionFailed: true,
        }),
        recoverServerConfig: jest.fn().mockImplementation(async () => {
          closeOwner();
          return { type: 'streamable-http', url: 'https://mcp.example.test' };
        }),
      });
    } else {
      fixture.dependencies.getMCPServersRegistry = () => ({
        recoverServerConfig: jest.fn(),
        getServerConfig: jest.fn().mockResolvedValue({
          type: 'streamable-http',
          url: 'https://mcp.example.test',
          customUserVars: { API_KEY: { title: 'Key' } },
        }),
      });
      fixture.dependencies.db.findPluginAuthsByKeys = jest.fn().mockImplementation(async () => {
        closeOwner();
        return [];
      });
    }
    await invokeHandler(fixture.dependencies, res);
    expect(fixture.reinitialize).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  },
);

it('aborts initialization on owner close and removes its listener', async () => {
  const fixture = setup();
  const res = ownedResponse();
  fixture.reinitialize.mockImplementationOnce(async ({ signal }) => {
    expect(signal.aborted).toBe(false);
    res.destroyed = true;
    res.emit('close');
    expect(signal.aborted).toBe(true);
    return { success: true, serverName: 'server' };
  });
  await invokeHandler(fixture.dependencies, res);
  expect(fixture.reinitialize).toHaveBeenCalledTimes(1);
  expect(res.json).not.toHaveBeenCalled();
  expect(res.listenerCount('close')).toBe(0);
});

it('does not initialize with credentials whose storage lookup failed', async () => {
  const fixture = setup();
  const res = ownedResponse();
  fixture.dependencies.getMCPServersRegistry = () => ({
    recoverServerConfig: jest.fn(),
    getServerConfig: jest.fn().mockResolvedValue({
      type: 'streamable-http',
      url: 'https://mcp.example.test',
      customUserVars: { API_KEY: { title: 'Key' } },
    }),
  });
  fixture.dependencies.db.findPluginAuthsByKeys = jest
    .fn()
    .mockRejectedValue(new Error('synthetic storage failure'));
  await invokeHandler(fixture.dependencies, res);
  expect(fixture.reinitialize).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  expect(res.listenerCount('close')).toBe(0);
});

it('does not write an error after the response owner disconnects', async () => {
  const fixture = setup();
  const res = ownedResponse();
  fixture.dependencies.resolveConfigServers = async () => {
    res.destroyed = true;
    res.emit('close');
    throw new Error('synthetic storage failure');
  };
  await invokeHandler(fixture.dependencies, res);
  expect(fixture.reinitialize).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
  expect(res.listenerCount('close')).toBe(0);
});

it('removes the response listener after a normal successful operation', async () => {
  const fixture = setup();
  const res = ownedResponse();
  await invokeHandler(fixture.dependencies, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  expect(res.listenerCount('close')).toBe(0);
});

it('does not read credential storage for an empty custom-variable map', async () => {
  const fixture = setup();
  const res = ownedResponse();
  fixture.dependencies.getMCPServersRegistry = () => ({
    recoverServerConfig: jest.fn(),
    getServerConfig: jest.fn().mockResolvedValue({
      type: 'streamable-http',
      url: 'https://mcp.example.test',
      customUserVars: {},
    }),
  });
  fixture.dependencies.db.findPluginAuthsByKeys = jest
    .fn()
    .mockRejectedValue(new Error('synthetic storage failure'));
  await invokeHandler(fixture.dependencies, res);
  expect(fixture.dependencies.db.findPluginAuthsByKeys).not.toHaveBeenCalled();
  expect(fixture.reinitialize).toHaveBeenCalledWith(
    expect.objectContaining({ userMCPAuthMap: undefined }),
  );
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
});
