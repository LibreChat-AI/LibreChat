import type { AppConfig } from '@librechat/data-schemas';
import { createMCPPolicyResolver } from '~/mcp/registry/policy';

describe('createMCPPolicyResolver', () => {
  it('reads the principal config strictly and reports the servers it keeps', async () => {
    const getAppConfig = jest.fn().mockResolvedValue({
      mcpConfig: { github: { url: 'https://github.example.com/mcp' }, docs: {} },
      mcpSettings: {
        apps: true,
        allowedDomains: ['merged.com'],
        allowedAddresses: ['10.0.0.0/8'],
      },
    } as unknown as AppConfig);
    const resolve = createMCPPolicyResolver(getAppConfig);

    const resolved = await resolve({ userId: 'u1', role: 'ADMIN' });

    expect(getAppConfig).toHaveBeenCalledWith({
      role: 'ADMIN',
      userId: 'u1',
      failClosed: true,
      skipRuntimeAugmentation: true,
    });
    expect(resolved).toEqual({
      serverNames: ['github', 'docs'],
      allowedDomains: ['merged.com'],
      allowedAddresses: ['10.0.0.0/8'],
      mcpApps: expect.objectContaining({ enabled: true, legacyHtmlEnabled: true }),
    });
  });

  it("passes the identity the caller's request loaded, so the read needs no user lookup", async () => {
    const getAppConfig = jest.fn().mockResolvedValue({} as AppConfig);
    const resolve = createMCPPolicyResolver(getAppConfig);

    await resolve({ userId: 'u1', role: 'USER', idOnTheSource: null });
    await resolve({ userId: 'u2', role: 'USER', idOnTheSource: 'entra-oid' });

    expect(getAppConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idOnTheSource: null }),
    );
    expect(getAppConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idOnTheSource: 'entra-oid' }),
    );
  });

  it('reports no kept servers when the merge removed the whole section', async () => {
    const resolve = createMCPPolicyResolver(jest.fn().mockResolvedValue({} as AppConfig));

    await expect(resolve({ userId: 'u1' })).resolves.toEqual(
      expect.objectContaining({ serverNames: [] }),
    );
  });

  it('propagates a failed read so the registry can fail closed', async () => {
    const failure = new Error('overrides unavailable');
    const resolve = createMCPPolicyResolver(jest.fn().mockRejectedValue(failure));

    await expect(resolve({ userId: 'u1' })).rejects.toBe(failure);
  });
});
