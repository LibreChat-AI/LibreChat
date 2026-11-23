import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

import { createAdminCodeEnvironmentHandlers } from './code';

interface MockResponse extends Response {
  statusCode: number;
  body?: Record<string, unknown>;
}

function mockResponse(): MockResponse {
  const response = {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      response.body = body;
      return response;
    },
  };
  return response as unknown as MockResponse;
}

function request(): ServerRequest {
  return {
    params: { environmentId: 'attached-vm' },
    user: { id: 'admin-1', role: 'ADMIN', tenantId: 'tenant-1' },
  } as unknown as ServerRequest;
}

function config(): AppConfig {
  return {
    endpoints: {
      agents: {
        statefulCodeSessions: {
          allowedEnvironments: ['conversation'],
          environments: [
            {
              id: 'attached-vm',
              name: 'Attached VM',
              type: 'attached',
              baseURL: 'https://bridge.example.com/v1/',
              default: true,
              owner: 'deployment',
              pairing: {
                workerId: 'vm-1',
                tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
              },
            },
          ],
        },
      },
    },
  } as unknown as AppConfig;
}

describe('createAdminCodeEnvironmentHandlers', () => {
  it('creates a one-time pairing code without exposing the administrator token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        code: 'one-time-code-value-that-is-long',
        expiresAt: '2099-08-30T12:00:00.000Z',
      }),
    );
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(config()),
      readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
      fetchImpl,
    });
    const response = mockResponse();

    await handlers.createPairing(request(), response);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bridge.example.com/v1/bridge/pairings',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer administrator-bootstrap-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workerId: 'vm-1',
          binding: {
            tenantId: 'tenant-1',
            principal: { type: 'deployment', id: 'attached-vm' },
          },
        }),
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      environmentId: 'attached-vm',
      workerId: 'vm-1',
      code: 'one-time-code-value-that-is-long',
      expiresAt: '2099-08-30T12:00:00.000Z',
    });
    expect(JSON.stringify(response.body)).not.toContain('administrator-bootstrap-token');
  });

  it('fails closed before outbound traffic when tenant context is unavailable', async () => {
    const fetchImpl = jest.fn();
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(config()),
      resolveTenantId: jest.fn(() => {
        throw new Error('missing tenant context');
      }),
      readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
      fetchImpl,
    });
    const response = mockResponse();

    await handlers.createPairing(request(), response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Code environment tenant context is unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses only YAML config when resolving pairing secrets and destinations', async () => {
    const writableOverride = config();
    const overriddenEnvironment =
      writableOverride.endpoints?.agents?.statefulCodeSessions?.environments?.[0];
    if (overriddenEnvironment == null) {
      throw new Error('Expected the test code environment');
    }
    overriddenEnvironment.baseURL = 'https://attacker.example.com/v1';
    overriddenEnvironment.pairing = {
      workerId: 'vm-1',
      allowPrincipalWorkers: false,
      tokenEnv: 'DATABASE_URL',
    };
    const getAppConfig = jest.fn(async (options: { baseOnly?: boolean }) =>
      options.baseOnly === true ? config() : writableOverride,
    );
    const readSecret = jest.fn((name: string) =>
      name === 'CODE_BRIDGE_ADMIN_TOKEN' ? 'deployment-token' : 'sensitive-database-secret',
    );
    const fetchImpl = jest.fn().mockResolvedValue(
      Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        code: 'one-time-code-value-that-is-long',
        expiresAt: '2099-08-30T12:00:00.000Z',
      }),
    );
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig,
      readSecret,
      fetchImpl,
    });

    await handlers.createPairing(request(), mockResponse());

    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(readSecret).toHaveBeenCalledWith('CODE_BRIDGE_ADMIN_TOKEN');
    expect(readSecret).not.toHaveBeenCalledWith('DATABASE_URL');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bridge.example.com/v1/bridge/pairings',
      expect.any(Object),
    );
  });

  it('fails closed before outbound traffic when the administrator token is unavailable', async () => {
    const fetchImpl = jest.fn();
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(config()),
      readSecret: jest.fn().mockReturnValue(undefined),
      fetchImpl,
    });
    const response = mockResponse();

    await handlers.createPairing(request(), response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Code environment pairing is not configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats inherited process environment properties as missing secrets', async () => {
    const deploymentConfig = config();
    const environment = deploymentConfig.endpoints?.agents?.statefulCodeSessions?.environments?.[0];
    if (environment?.pairing == null) throw new Error('Expected the test pairing configuration');
    environment.pairing.tokenEnv = 'constructor';
    const fetchImpl = jest.fn();
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(deploymentConfig),
      fetchImpl,
    });
    const response = mockResponse();

    await handlers.createPairing(request(), response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Code environment pairing is not configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normalizes the bridge base URL before appending control paths', async () => {
    const deploymentConfig = config();
    const environment = deploymentConfig.endpoints?.agents?.statefulCodeSessions?.environments?.[0];
    if (environment == null) throw new Error('Expected the test code environment');
    environment.baseURL = '  https://bridge.example.com/v1/  ';
    const fetchImpl = jest.fn().mockResolvedValue(
      Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        code: 'one-time-code-value-that-is-long',
        expiresAt: '2099-08-30T12:00:00.000Z',
      }),
    );
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(deploymentConfig),
      readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
      fetchImpl,
    });

    await handlers.createPairing(request(), mockResponse());

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bridge.example.com/v1/bridge/pairings',
      expect.any(Object),
    );
  });

  it('rejects insecure non-loopback pairing before reading or sending credentials', async () => {
    const deploymentConfig = config();
    const environment = deploymentConfig.endpoints?.agents?.statefulCodeSessions?.environments?.[0];
    if (environment == null) throw new Error('Expected the test code environment');
    environment.baseURL = 'http://bridge.example.com/v1';
    const readSecret = jest.fn().mockReturnValue('administrator-bootstrap-token');
    const fetchImpl = jest.fn();
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(deploymentConfig),
      readSecret,
      fetchImpl,
    });
    const response = mockResponse();

    await handlers.createPairing(request(), response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'Code environment pairing requires secure transport',
    });
    expect(readSecret).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an expired one-time pairing code', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        code: 'expired-one-time-code-value',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    );
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(config()),
      readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
      fetchImpl,
    });
    const response = mockResponse();

    await handlers.createPairing(request(), response);

    expect(response.statusCode).toBe(502);
    expect(response.body).toEqual({ error: 'Code API returned an invalid pairing response' });
  });

  it('rejects a pairing code outside the 32-character base64url wire format', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      Response.json({
        protocolVersion: 1,
        workerId: 'vm-1',
        code: 'invalid code value with whitespace',
        expiresAt: '2099-08-30T12:00:00.000Z',
      }),
    );
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(config()),
      readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
      fetchImpl,
    });
    const response = mockResponse();

    await handlers.createPairing(request(), response);

    expect(response.statusCode).toBe(502);
    expect(response.body).toEqual({ error: 'Code API returned an invalid pairing response' });
  });

  it('revokes the environment worker without returning bridge credentials', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(Response.json({ protocolVersion: 1, revoked: true }));
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(config()),
      readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
      fetchImpl,
    });
    const response = mockResponse();

    await handlers.revokeWorker(request(), response);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bridge.example.com/v1/bridge/workers/vm-1/revoke',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      environmentId: 'attached-vm',
      workerId: 'vm-1',
      revoked: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('administrator-bootstrap-token');
  });

  it('rejects an invalid revocation acknowledgement', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(Response.json({ protocolVersion: 1, revoked: false }));
    const handlers = createAdminCodeEnvironmentHandlers({
      getAppConfig: jest.fn().mockResolvedValue(config()),
      readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
      fetchImpl,
    });
    const response = mockResponse();

    await handlers.revokeWorker(request(), response);

    expect(response.statusCode).toBe(502);
    expect(response.body).toEqual({ error: 'Code API returned an invalid revocation response' });
  });

  describe('audit entries', () => {
    function build(fetchImpl: jest.Mock, recordAuditEntry: jest.Mock) {
      return createAdminCodeEnvironmentHandlers({
        getAppConfig: jest.fn().mockResolvedValue(config()),
        readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
        fetchImpl,
        recordAuditEntry,
      });
    }

    it('records code_worker.paired without the pairing code', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const fetchImpl = jest.fn().mockResolvedValue(
        Response.json({
          protocolVersion: 1,
          workerId: 'vm-1',
          code: 'one-time-code-value-that-is-long',
          expiresAt: '2099-08-30T12:00:00.000Z',
        }),
      );

      await build(fetchImpl, recordAuditEntry).createPairing(request(), mockResponse());

      expect(recordAuditEntry.mock.calls.map(([entry]) => entry.outcome ?? 'success')).toEqual([
        'pending',
        'success',
      ]);
      const input = recordAuditEntry.mock.calls[1][0];
      expect(input).toEqual(
        expect.objectContaining({
          action: 'code_worker.paired',
          target: { type: 'code_worker', id: 'vm-1', name: 'attached-vm' },
        }),
      );
      expect(input.tenantId).toBeUndefined();
      expect(input.metadata.boundTenantId).toEqual(expect.any(String));
      expect(JSON.stringify(recordAuditEntry.mock.calls)).not.toContain(
        'one-time-code-value-that-is-long',
      );
      expect(JSON.stringify(recordAuditEntry.mock.calls)).not.toContain(
        'administrator-bootstrap-token',
      );
    });

    it('records code_worker.revoked as pending, then success or a failure entry when it is not confirmed', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const ok = jest.fn().mockResolvedValue(Response.json({ protocolVersion: 1, revoked: true }));
      const bad = jest
        .fn()
        .mockResolvedValue(Response.json({ protocolVersion: 1, revoked: false }));

      await build(ok, recordAuditEntry).revokeWorker(request(), mockResponse());
      expect(recordAuditEntry).toHaveBeenCalledTimes(2);
      expect(recordAuditEntry).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          action: 'code_worker.revoked',
          outcome: 'pending',
          target: { type: 'code_worker', id: 'vm-1', name: 'attached-vm' },
        }),
      );
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'code_worker.revoked', outcome: 'success' }),
      );

      recordAuditEntry.mockClear();
      await build(bad, recordAuditEntry).revokeWorker(request(), mockResponse());
      expect(recordAuditEntry).toHaveBeenCalledTimes(2);
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outcome: 'failure',
          metadata: { environmentId: 'attached-vm', code: 'invalid_response' },
        }),
      );
    });

    it('records the pairing before the bridge call and a failure entry when no code is minted', async () => {
      const order: string[] = [];
      const recordAuditEntry = jest.fn().mockImplementation(async (input) => {
        order.push(`audit:${input.outcome ?? 'success'}`);
      });
      const fetchImpl = jest.fn().mockImplementation(async () => {
        order.push('bridge');
        return new Response('nope', { status: 500 });
      });

      await build(fetchImpl, recordAuditEntry).createPairing(request(), mockResponse());

      expect(order).toEqual(['audit:pending', 'bridge', 'audit:failure']);
      expect(recordAuditEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ code: 'bridge_rejected' }) }),
      );
    });

    it('sends the revocation without waiting for a slow pending audit write', async () => {
      const order: string[] = [];
      let release: () => void = () => undefined;
      const recordAuditEntry = jest.fn().mockImplementation(async (input) => {
        if (input.outcome === 'pending') {
          await new Promise<void>((resolve) => (release = resolve));
        }
        order.push(`audit:${input.outcome ?? 'success'}`);
      });
      const fetchImpl = jest.fn().mockImplementation(async () => {
        order.push('bridge');
        release();
        return Response.json({ protocolVersion: 1, revoked: true });
      });

      await build(fetchImpl, recordAuditEntry).revokeWorker(request(), mockResponse());

      expect(order).toEqual(['bridge', 'audit:pending', 'audit:success']);
    });

    it('delivers the pairing code before the terminal audit write settles', async () => {
      let release: () => void = () => undefined;
      let deliveredAtTerminalWrite: unknown;
      const response = mockResponse();
      const recordAuditEntry = jest.fn().mockImplementation(async (input) => {
        if (input.outcome === undefined || input.outcome === 'success') {
          deliveredAtTerminalWrite = response.body;
          await new Promise<void>((resolve) => (release = resolve));
        }
      });
      const fetchImpl = jest.fn().mockResolvedValue(
        Response.json({
          protocolVersion: 1,
          workerId: 'vm-1',
          code: 'one-time-code-value-that-is-long',
          expiresAt: '2099-08-30T12:00:00.000Z',
        }),
      );

      const pending = build(fetchImpl, recordAuditEntry).createPairing(request(), response);
      await new Promise((resolve) => setImmediate(resolve));
      release();
      await pending;
      expect(deliveredAtTerminalWrite).toEqual(expect.objectContaining({ workerId: 'vm-1' }));
    });

    it('does not pair a worker when the pending audit write fails under fail-closed', async () => {
      const fetchImpl = jest.fn();
      const response = mockResponse();

      await createAdminCodeEnvironmentHandlers({
        getAppConfig: jest.fn().mockResolvedValue(config()),
        readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
        fetchImpl,
        recordAuditEntry: jest.fn().mockRejectedValue(new Error('audit down')),
        auditFailClosed: true,
      })
        .createPairing(request(), response)
        .catch(() => undefined);

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('never blocks a revocation on an audit outage, even when fail-closed', async () => {
      const ok = jest.fn().mockResolvedValue(Response.json({ protocolVersion: 1, revoked: true }));
      const response = mockResponse();

      await createAdminCodeEnvironmentHandlers({
        getAppConfig: jest.fn().mockResolvedValue(config()),
        readSecret: jest.fn().mockReturnValue('administrator-bootstrap-token'),
        fetchImpl: ok,
        recordAuditEntry: jest.fn().mockRejectedValue(new Error('audit down')),
        auditFailClosed: true,
      }).revokeWorker(request(), response);

      expect(response.statusCode).toBe(200);
    });

    it('does not fail the pairing when the audit write fails (fail-open)', async () => {
      const recordAuditEntry = jest.fn().mockRejectedValue(new Error('audit down'));
      const fetchImpl = jest.fn().mockResolvedValue(
        Response.json({
          protocolVersion: 1,
          workerId: 'vm-1',
          code: 'one-time-code-value-that-is-long',
          expiresAt: '2099-08-30T12:00:00.000Z',
        }),
      );
      const response = mockResponse();

      await build(fetchImpl, recordAuditEntry).createPairing(request(), response);

      expect(response.statusCode).toBe(200);
    });
  });
});
