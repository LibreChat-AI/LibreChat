import { SystemCapabilities } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import {
  isAgentCertificationEnabled,
  createAgentCertificationHandler,
  getAgentCertificationStartupConfig,
} from './certification';

type Config = Parameters<typeof isAgentCertificationEnabled>[0];

const enabledConfig = { interfaceConfig: { agentCertification: { enabled: true } } } as Config;

function mockResponse() {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response['json'];
  return res;
}

function mockRequest(overrides: { id?: string; body?: unknown; config?: Config }) {
  return {
    params: { id: overrides.id ?? 'agent_1' },
    body: overrides.body,
    config: 'config' in overrides ? overrides.config : enabledConfig,
    user: { id: 'user_1', role: 'ADMIN' },
  } as unknown as Request & { config?: Config };
}

describe('isAgentCertificationEnabled', () => {
  it('is off unless explicitly enabled', () => {
    expect(isAgentCertificationEnabled(undefined)).toBe(false);
    expect(isAgentCertificationEnabled({ interfaceConfig: {} } as Config)).toBe(false);
    expect(
      isAgentCertificationEnabled({
        interfaceConfig: { agentCertification: { enabled: false } },
      } as Config),
    ).toBe(false);
    expect(isAgentCertificationEnabled(enabledConfig)).toBe(true);
  });
});

describe('createAgentCertificationHandler', () => {
  const logger = { error: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('returns 404 and writes nothing while certification is disabled', async () => {
    const setAgentCertification = jest.fn();
    const handler = createAgentCertificationHandler({ setAgentCertification, logger });
    const res = mockResponse();

    await handler(mockRequest({ body: { is_certified: true }, config: undefined }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'agent_certification_disabled' });
    expect(setAgentCertification).not.toHaveBeenCalled();
  });

  it.each([[undefined], [{}], [{ is_certified: 'true' }], [{ is_certified: 1 }]])(
    'rejects a non-boolean flag (%p)',
    async (body) => {
      const setAgentCertification = jest.fn();
      const handler = createAgentCertificationHandler({ setAgentCertification, logger });
      const res = mockResponse();

      await handler(mockRequest({ body }), res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'is_certified_must_be_boolean' });
      expect(setAgentCertification).not.toHaveBeenCalled();
    },
  );

  it('sets the flag and returns the stored state', async () => {
    const setAgentCertification = jest
      .fn()
      .mockResolvedValue({ id: 'agent_1', is_certified: false });
    const handler = createAgentCertificationHandler({ setAgentCertification, logger });
    const res = mockResponse();

    await handler(mockRequest({ body: { is_certified: false } }), res);

    expect(setAgentCertification).toHaveBeenCalledWith('agent_1', false);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'agent_1', is_certified: false });
  });

  it('distinguishes a missing agent from a failure', async () => {
    const setAgentCertification = jest.fn().mockResolvedValue(null);
    const handler = createAgentCertificationHandler({ setAgentCertification, logger });
    const res = mockResponse();

    await handler(mockRequest({ body: { is_certified: true } }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'agent_not_found' });
  });

  it('maps a database failure to a stable code without exposing the error', async () => {
    const setAgentCertification = jest
      .fn()
      .mockRejectedValue(new Error('connection to mongodb://secret-host refused'));
    const handler = createAgentCertificationHandler({ setAgentCertification, logger });
    const res = mockResponse();

    await handler(mockRequest({ body: { is_certified: true } }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'agent_certification_failed' });
    expect(JSON.stringify(res.body)).not.toContain('secret-host');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-host');
  });
});

describe('getAgentCertificationStartupConfig', () => {
  const logger = { warn: jest.fn() };
  const user = { id: 'user_1', role: 'ADMIN', tenantId: 'tenant_a' };

  it('skips the capability lookup while certification is disabled', async () => {
    const hasCapability = jest.fn();

    await expect(
      getAgentCertificationStartupConfig({ hasCapability, logger }, undefined, user),
    ).resolves.toEqual({});
    expect(hasCapability).not.toHaveBeenCalled();
  });

  it('reports manage:agents for the requesting user', async () => {
    const hasCapability = jest.fn().mockResolvedValue(true);

    await expect(
      getAgentCertificationStartupConfig({ hasCapability, logger }, enabledConfig, user),
    ).resolves.toEqual({ canManageAgentCertification: true });
    expect(hasCapability).toHaveBeenCalledWith(
      { id: 'user_1', role: 'ADMIN', tenantId: 'tenant_a', idOnTheSource: null },
      SystemCapabilities.MANAGE_AGENTS,
    );
  });

  it('fails closed when the capability lookup throws', async () => {
    const hasCapability = jest.fn().mockRejectedValue(new Error('db down'));

    await expect(
      getAgentCertificationStartupConfig({ hasCapability, logger }, enabledConfig, user),
    ).resolves.toEqual({ canManageAgentCertification: false });
  });
});
