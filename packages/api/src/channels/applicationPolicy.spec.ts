import { tenantStorage } from '@librechat/data-schemas';
import type { AppConfig, IUser, AgentChannelRecord } from '@librechat/data-schemas';
import type { Request } from 'express';
import { createChannelApplicationPolicy } from './applicationPolicy';

function fixture(tenantId: string | undefined) {
  const user = {
    _id: 'user-a',
    id: 'user-a',
    tenantId,
    role: 'USER',
    idOnTheSource: 'external-a',
  } as unknown as IUser;
  const config = {
    endpoints: { agents: { channels: { enabled: true } } },
    interfaceConfig: { feedback: true },
  } as unknown as AppConfig;
  const readAppConfig = jest.fn().mockResolvedValue(config);
  const findUser = jest.fn().mockResolvedValue(user);
  const isPrincipalActive = jest.fn().mockResolvedValue(true);
  const policy = createChannelApplicationPolicy({ readAppConfig, findUser, isPrincipalActive });
  return { policy, user, config, readAppConfig, findUser, isPrincipalActive };
}

it.each(['tenant-a', undefined])(
  'loads current principal overrides in the application tenant %s',
  async (tenantId) =>
    tenantStorage.run({ tenantId }, async () => {
      const f = fixture(tenantId);
      expect(await f.policy.appConfig(tenantId || '_', 'user-a')).toBe(f.config);
      expect(f.readAppConfig).toHaveBeenCalledWith({
        tenantId,
        userId: 'user-a',
        role: 'USER',
        idOnTheSource: 'external-a',
        failClosed: true,
      });
      expect(f.readAppConfig.mock.calls[0][0]).not.toHaveProperty('baseOnly');
    }),
);

it('reuses the authenticated management principal and honors its effective disabled policy', async () =>
  tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
    const f = fixture('tenant-a');
    f.readAppConfig.mockResolvedValue({ endpoints: { agents: { channels: { enabled: false } } } });
    expect((await f.policy.requestConfig({ user: f.user } as unknown as Request)).enabled).toBe(
      false,
    );
    expect(f.findUser).not.toHaveBeenCalled();
    expect(f.readAppConfig.mock.calls[0][0].userId).toBe('user-a');
  }));

it('loads service policy for the canonical channel owner after establishing its tenant', async () =>
  tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
    const f = fixture('tenant-a');
    const channel = { tenantId: 'tenant-a', createdBy: 'user-a' } as AgentChannelRecord;
    expect((await f.policy.requestConfig({} as Request, channel)).enabled).toBe(true);
    expect(f.findUser).toHaveBeenCalledWith({ _id: 'user-a' });
    expect(f.readAppConfig.mock.calls[0][0].tenantId).toBe('tenant-a');
  }));

it('refuses foreign and missing source principals without a base-policy fallback', async () =>
  tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
    const f = fixture('other-tenant');
    await expect(f.policy.appConfig('tenant-a', 'user-a')).rejects.toThrow('tenant changed');
    await expect(f.policy.appConfig('other-tenant', 'user-a')).rejects.toThrow('tenant changed');
    f.findUser.mockResolvedValue(null);
    await expect(f.policy.appConfig('tenant-a', 'user-a')).rejects.toThrow('unavailable');
    expect(f.readAppConfig).not.toHaveBeenCalled();
  }));

it('rechecks current trace policy and propagates configuration outages', async () =>
  tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
    const f = fixture('tenant-a');
    f.readAppConfig.mockResolvedValue({ ...f.config, interfaceConfig: { feedback: false } });
    expect(await f.policy.tracePolicy({ tenantId: 'tenant-a', userId: 'user-a' })).toEqual({
      centralTraceExportEnabled: false,
    });
    f.isPrincipalActive.mockResolvedValue(false);
    expect(await f.policy.tracePolicy({ tenantId: 'tenant-a', userId: 'user-a' })).toBeNull();
    f.readAppConfig.mockRejectedValue(new Error('private configuration outage'));
    await expect(f.policy.config(f.user)).rejects.toThrow('configuration outage');
  }));

it('allows central feedback export for a live source when current tracing policy permits it', async () =>
  tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
    const enabled = process.env.LANGFUSE_TRACING_ENABLED;
    const sampleRate = process.env.LANGFUSE_SAMPLE_RATE;
    process.env.LANGFUSE_TRACING_ENABLED = 'true';
    process.env.LANGFUSE_SAMPLE_RATE = '1';
    try {
      const f = fixture('tenant-a');
      expect(await f.policy.tracePolicy({ tenantId: 'tenant-a', userId: 'user-a' })).toEqual({
        centralTraceExportEnabled: true,
      });
      expect(f.readAppConfig.mock.calls[0][0].failClosed).toBe(true);
    } finally {
      if (enabled === undefined) delete process.env.LANGFUSE_TRACING_ENABLED;
      else process.env.LANGFUSE_TRACING_ENABLED = enabled;
      if (sampleRate === undefined) delete process.env.LANGFUSE_SAMPLE_RATE;
      else process.env.LANGFUSE_SAMPLE_RATE = sampleRate;
    }
  }));
