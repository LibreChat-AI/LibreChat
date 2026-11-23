import { getAgentListAvatarRefreshKey } from './listingAvatars';

describe('Agent listing avatar scope', () => {
  it('uses the same tenant-qualified key for listing and upload, including legacy users', () => {
    expect(getAgentListAvatarRefreshKey({ id: 'alice', tenantId: 'tenant-a' })).toBe(
      'alice:tenant-a:agents_avatar_refresh',
    );
    expect(getAgentListAvatarRefreshKey({ id: 'alice', tenantId: 'tenant-b' })).not.toBe(
      getAgentListAvatarRefreshKey({ id: 'alice', tenantId: 'tenant-a' }),
    );
    expect(getAgentListAvatarRefreshKey({ id: 'alice' })).toBe('alice::agents_avatar_refresh');
  });
});
