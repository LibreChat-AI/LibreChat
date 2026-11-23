import { FileSources } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { loadStrictAppConfig } from './strict';

const base: AppConfig = { config: {}, fileStrategy: FileSources.local, imageOutputType: 'png' };
const user = { id: 'user-1', role: 'USER', tenantId: 'tenant-1', idOnTheSource: null };

test('does not trust a preloaded fallback and propagates principal/override failures', async () => {
  const req = { user, config: base };
  const failure = new Error('Override reader unavailable');
  const reader = jest.fn().mockRejectedValue(failure);
  await expect(loadStrictAppConfig(req, reader)).rejects.toBe(failure);
  expect(reader).toHaveBeenCalledTimes(1);
  expect(reader).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: user.id,
      role: user.role,
      tenantId: user.tenantId,
      idOnTheSource: null,
      failClosed: true,
    }),
  );
});

test('reuses a successful strict read across middleware on the same request', async () => {
  const effective = { ...base, modelSpecs: { list: [] } };
  const req = { user, config: base };
  const reader = jest.fn().mockResolvedValue(effective);
  req.config = await loadStrictAppConfig(req, reader);
  expect(await loadStrictAppConfig(req, reader)).toBe(effective);
  expect(reader).toHaveBeenCalledTimes(1);
});

test('cannot reuse a cached strict result after the principal, tenant, or config changes', async () => {
  const req = { user: { ...user }, config: base };
  const reader = jest.fn(async () => ({ ...base }));
  req.config = await loadStrictAppConfig(req, reader);
  req.user.role = 'ADMIN';
  req.config = await loadStrictAppConfig(req, reader);
  req.user.tenantId = 'tenant-2';
  req.config = await loadStrictAppConfig(req, reader);
  req.config = { ...base };
  req.config = await loadStrictAppConfig(req, reader);
  expect(reader).toHaveBeenCalledTimes(4);
});

test('fails closed when the effective config is unavailable', async () => {
  await expect(loadStrictAppConfig({ user }, async () => undefined)).rejects.toThrow(
    'Effective app configuration unavailable',
  );
});

test('does not carry strict-read authority into a cloned request', async () => {
  const req = { user, config: base };
  const reader = jest.fn(async () => ({ ...base }));
  req.config = await loadStrictAppConfig(req, reader);
  await loadStrictAppConfig({ ...req }, reader);
  expect(reader).toHaveBeenCalledTimes(2);
});
