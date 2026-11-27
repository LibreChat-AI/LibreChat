import { canAccessMCPOAuthFlow } from './access';

const userId = 'user-123';

describe('canAccessMCPOAuthFlow', () => {
  it.each([
    ['user-123:server', undefined],
    ['user-123:server:with:colons', undefined],
    ['user-123:server', 'tenant-a'],
    ['tenant:tenant-a:user-123:server', 'tenant-a'],
    ['tenant:tenant%2Fa:user-123:server', 'tenant/a'],
  ])('allows the owner of %s in tenant %s', (flowId, tenantId) => {
    expect(canAccessMCPOAuthFlow(flowId, userId, tenantId)).toBe(true);
  });

  it.each([
    ['system:server', undefined],
    ['tenant:tenant-a:system:server', 'tenant-a'],
    ['tenant:tenant-a:system:server', 'tenant-b'],
    ['tenant:tenant-a:system:server', undefined],
  ])('denies system flow %s in tenant %s', (flowId, tenantId) => {
    expect(canAccessMCPOAuthFlow(flowId, userId, tenantId)).toBe(false);
    expect(canAccessMCPOAuthFlow(flowId, 'system', tenantId)).toBe(false);
  });

  it.each([
    ['other-user:server', undefined],
    ['tenant:tenant-a:other-user:server', 'tenant-a'],
    ['tenant:tenant-a:user-123:server', 'tenant-b'],
    ['tenant:tenant-a:user-123:server', undefined],
  ])('denies another principal access to %s in tenant %s', (flowId, tenantId) => {
    expect(canAccessMCPOAuthFlow(flowId, userId, tenantId)).toBe(false);
  });

  it.each([
    '',
    'user-123',
    ':server',
    'user-123:',
    'tenant::user-123:server',
    'tenant:tenant-a::server',
    'tenant:tenant-a:user-123:',
    'tenant:%ZZ:user-123:server',
  ])('denies malformed flow ID %s', (flowId) => {
    expect(canAccessMCPOAuthFlow(flowId, userId)).toBe(false);
  });
});
