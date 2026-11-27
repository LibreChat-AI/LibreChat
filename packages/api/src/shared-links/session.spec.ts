import { configCapability, SystemCapabilities, type MessageMethods } from '@librechat/data-schemas';
import { createSharedLangfuseSessionResolver } from './session';

const getHeldCapabilities = jest.fn();
const getMessages = jest.fn() as unknown as MessageMethods['getMessages'];
const resolveSessionUrl = jest.fn();

const config = {
  enabled: true,
  destination: 'eu',
  projectId: 'project-1',
};

function createResolver() {
  return createSharedLangfuseSessionResolver({
    getHeldCapabilities,
    getMessages,
    resolveSessionUrl,
  });
}

const validParams = {
  viewer: { id: 'admin-1', role: 'ADMIN', tenantId: 'tenant-1' },
  shareTenantId: 'tenant-1',
  shareConversationId: 'conversation-1',
  shareOwnerId: 'owner-1',
  config,
};

describe('createSharedLangfuseSessionResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getHeldCapabilities.mockResolvedValue(
      new Set([SystemCapabilities.ACCESS_ADMIN, SystemCapabilities.MANAGE_CONFIGS]),
    );
    resolveSessionUrl.mockResolvedValue('https://cloud.langfuse.com/session-1');
  });

  it('resolves the source session for an authorized same-tenant admin', async () => {
    const result = await createResolver()(validParams);

    expect(result).toBe('https://cloud.langfuse.com/session-1');
    expect(getHeldCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-1', tenantId: 'tenant-1' }),
      [
        SystemCapabilities.ACCESS_ADMIN,
        SystemCapabilities.MANAGE_CONFIGS,
        configCapability('langfuse'),
      ],
    );
    expect(resolveSessionUrl).toHaveBeenCalledWith({
      config,
      conversationId: 'conversation-1',
      userId: 'owner-1',
      getMessages,
    });
  });

  it('rejects a viewer from another tenant before capability checks', async () => {
    const result = await createResolver()({
      ...validParams,
      viewer: { ...validParams.viewer, tenantId: 'tenant-2' },
    });

    expect(result).toBeNull();
    expect(getHeldCapabilities).not.toHaveBeenCalled();
    expect(resolveSessionUrl).not.toHaveBeenCalled();
  });

  it('rejects a viewer without admin access', async () => {
    getHeldCapabilities.mockResolvedValue(new Set([SystemCapabilities.MANAGE_CONFIGS]));

    const result = await createResolver()(validParams);

    expect(result).toBeNull();
    expect(resolveSessionUrl).not.toHaveBeenCalled();
  });

  it('rejects an admin without Langfuse config access', async () => {
    getHeldCapabilities.mockResolvedValue(new Set([SystemCapabilities.ACCESS_ADMIN]));

    const result = await createResolver()(validParams);

    expect(result).toBeNull();
    expect(resolveSessionUrl).not.toHaveBeenCalled();
  });

  it('accepts an admin with section-specific Langfuse config access', async () => {
    getHeldCapabilities.mockResolvedValue(
      new Set([SystemCapabilities.ACCESS_ADMIN, configCapability('langfuse')]),
    );

    const result = await createResolver()(validParams);

    expect(result).toBe('https://cloud.langfuse.com/session-1');
  });

  it('treats the system tenant and an omitted tenant as the same deployment', async () => {
    const result = await createResolver()({
      ...validParams,
      viewer: { id: 'admin-1', role: 'ADMIN' },
      shareTenantId: '__SYSTEM__',
    });

    expect(result).toBe('https://cloud.langfuse.com/session-1');
  });
});
