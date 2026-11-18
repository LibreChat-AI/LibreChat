import { SystemCapabilities } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import {
  isAgentOfficialStatusEnabled,
  createAgentOfficialStatusHandler,
  getAgentOfficialStatusStartupConfig,
} from './officialStatus';

type Config = Parameters<typeof isAgentOfficialStatusEnabled>[0];

const enabledConfig = { interfaceConfig: { agentOfficialStatus: { enabled: true } } } as Config;

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

describe('isAgentOfficialStatusEnabled', () => {
  it('is off unless explicitly enabled', () => {
    expect(isAgentOfficialStatusEnabled(undefined)).toBe(false);
    expect(isAgentOfficialStatusEnabled({ interfaceConfig: {} } as Config)).toBe(false);
    expect(
      isAgentOfficialStatusEnabled({
        interfaceConfig: { agentOfficialStatus: { enabled: false } },
      } as Config),
    ).toBe(false);
    expect(isAgentOfficialStatusEnabled(enabledConfig)).toBe(true);
  });
});

describe('createAgentOfficialStatusHandler', () => {
  const logger = { error: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('returns 404 and writes nothing while official status is disabled', async () => {
    const setAgentOfficialStatus = jest.fn();
    const handler = createAgentOfficialStatusHandler({ setAgentOfficialStatus, logger });
    const res = mockResponse();

    await handler(mockRequest({ body: { is_official: true }, config: undefined }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'agent_official_status_disabled' });
    expect(setAgentOfficialStatus).not.toHaveBeenCalled();
  });

  it.each([[undefined], [{}], [{ is_official: 'true' }], [{ is_official: 1 }]])(
    'rejects a non-boolean flag (%p)',
    async (body) => {
      const setAgentOfficialStatus = jest.fn();
      const handler = createAgentOfficialStatusHandler({ setAgentOfficialStatus, logger });
      const res = mockResponse();

      await handler(mockRequest({ body }), res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'is_official_must_be_boolean' });
      expect(setAgentOfficialStatus).not.toHaveBeenCalled();
    },
  );

  it('sets the flag and returns the stored state', async () => {
    const setAgentOfficialStatus = jest
      .fn()
      .mockResolvedValue({ id: 'agent_1', is_official: false });
    const handler = createAgentOfficialStatusHandler({ setAgentOfficialStatus, logger });
    const res = mockResponse();

    await handler(mockRequest({ body: { is_official: false } }), res);

    expect(setAgentOfficialStatus).toHaveBeenCalledWith('agent_1', false);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'agent_1', is_official: false });
  });

  it('distinguishes a missing agent from a failure', async () => {
    const setAgentOfficialStatus = jest.fn().mockResolvedValue(null);
    const handler = createAgentOfficialStatusHandler({ setAgentOfficialStatus, logger });
    const res = mockResponse();

    await handler(mockRequest({ body: { is_official: true } }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'agent_not_found' });
  });

  it('maps a database failure to a stable code without exposing the error', async () => {
    const setAgentOfficialStatus = jest
      .fn()
      .mockRejectedValue(new Error('connection to mongodb://secret-host refused'));
    const handler = createAgentOfficialStatusHandler({ setAgentOfficialStatus, logger });
    const res = mockResponse();

    await handler(mockRequest({ body: { is_official: true } }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'agent_official_status_failed' });
    expect(JSON.stringify(res.body)).not.toContain('secret-host');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-host');
  });
});

describe('getAgentOfficialStatusStartupConfig', () => {
  const logger = { warn: jest.fn() };
  const user = { id: 'user_1', role: 'ADMIN', tenantId: 'tenant_a' };

  it('skips the capability lookup while official status is disabled', async () => {
    const hasCapability = jest.fn();

    await expect(
      getAgentOfficialStatusStartupConfig({ hasCapability, logger }, undefined, user),
    ).resolves.toEqual({});
    expect(hasCapability).not.toHaveBeenCalled();
  });

  it('reports manage:agents for the requesting user', async () => {
    const hasCapability = jest.fn().mockResolvedValue(true);

    await expect(
      getAgentOfficialStatusStartupConfig({ hasCapability, logger }, enabledConfig, user),
    ).resolves.toEqual({ canManageAgentOfficialStatus: true });
    expect(hasCapability).toHaveBeenCalledWith(
      { id: 'user_1', role: 'ADMIN', tenantId: 'tenant_a', idOnTheSource: null },
      SystemCapabilities.MANAGE_AGENTS,
    );
  });

  it('fails closed when the capability lookup throws', async () => {
    const hasCapability = jest.fn().mockRejectedValue(new Error('db down'));

    await expect(
      getAgentOfficialStatusStartupConfig({ hasCapability, logger }, enabledConfig, user),
    ).resolves.toEqual({ canManageAgentOfficialStatus: false });
  });
});
