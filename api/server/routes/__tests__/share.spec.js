const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const mockGetSharedLinkExpiration = jest.fn();
const mockGrantCreationPermissions = jest.fn();
const mockUpdateSharedLinkPermissionsExpiration = jest.fn();
const mockRecordShareLinkRejection = jest.fn();
const mockSharedLinksAccess = jest.fn((_req, _res, next) => next());
const mockSharedLinkConfigMiddleware = jest.fn((_req, _res, next) => next());
let mockShareTenantId;
const mockHasCapability = jest.fn();
const mockHasConfigCapability = jest.fn();
const mockGetSharedLangfuseSessionUrl = jest.fn();
const mockBuildSharedLinkStartupPayload = jest.fn();
const mockCanAccessSharedLink = jest.fn((req, _res, next) => {
  req.shareResourceId = 'resource-123';
  req.shareTenantId = mockShareTenantId;
  req.shareConversationId = 'conversation-owner-123';
  req.shareOwnerId = 'owner-123';
  next();
});
const mockGetAppConfig = jest.fn();
const mockShareIpLimiter = jest.fn((_req, _res, next) => next());
const mockShareUserLimiter = jest.fn((_req, _res, next) => next());
const mockParseSharedLinksPageSize = jest.fn(() => 10);
const mockIsValidSharedLinksCursor = jest.fn(() => true);
const mockAssertConversationContentAllowed = jest.fn();
const mockAssertModelBoundContent = jest.fn();
const mockAssertSharedFileMetadataAllowed = jest.fn();
const mockCreateShareContentPreflight = jest.fn((filters, options = {}) => {
  const legacyPii = options.legacyPii;
  if (filters == null && legacyPii == null) {
    return undefined;
  }
  const omitFiles = (messages) =>
    messages.map(({ files: _files, attachments: _attachments, ...message }) => ({
      ...message,
      ...(Array.isArray(message.content)
        ? {
            content: message.content.map((part) => {
              if (part?.type !== 'steer' || part.files === undefined) {
                return part;
              }
              const { files: _partFiles, ...rest } = part;
              return rest;
            }),
          }
        : {}),
    }));
  return async ({ title, messages, shareId }) => {
    const inspectSharedFileMetadata = options.sharedFileMetadata === true;
    const inspectSharedFiles =
      inspectSharedFileMetadata && options.sharedFileMetadataFiles !== false;
    const snapshot = {
      conversations: [{ title }],
      messages:
        options.snapshotFiles === false || inspectSharedFiles ? omitFiles(messages) : messages,
    };
    const context = {
      ...(options.user == null ? {} : { user: options.user, getFiles: options.getFiles }),
      ...(legacyPii == null ? {} : { legacyPii }),
    };
    await mockAssertConversationContentAllowed(
      filters,
      snapshot,
      ...(Object.keys(context).length === 0 ? [] : [context]),
    );
    if (inspectSharedFileMetadata) {
      mockAssertSharedFileMetadataAllowed({
        filters,
        messages: options.snapshotFiles === false ? omitFiles(messages) : messages,
        shareId,
        ...(options.sharedFileMetadataFiles === false && { includeFiles: false }),
      });
    }
  };
});

jest.mock('@librechat/api', () => ({
  resolveDownloadPath: (file) => file.storageKey || file.filepath,
  assertModelBoundContent: (...args) => mockAssertModelBoundContent(...args),
  assertSharedFileMetadataAllowed: (...args) => mockAssertSharedFileMetadataAllowed(...args),
  createShareContentPreflight: (...args) => mockCreateShareContentPreflight(...args),
  isEnabled: jest.fn(() => true),
  generateCheckAccess: jest.fn(() => mockSharedLinksAccess),
  grantCreationPermissions: (...args) => mockGrantCreationPermissions(...args),
  updateSharedLinkPermissionsExpiration: (...args) =>
    mockUpdateSharedLinkPermissionsExpiration(...args),
  ensureLinkPermissions: jest.fn(),
  isFileSnapshotEnabled: jest.fn(() => true),
  isFileSnapshotKillSwitchActive: jest.fn(() => false),
  buildSharedLinkStartupPayload: (...args) => mockBuildSharedLinkStartupPayload(...args),
  createSharedLinkConfigMiddleware: jest.fn(() => mockSharedLinkConfigMiddleware),
  deleteSharedLinkWithCleanup: jest.fn(),
  getSharedLinkExpiration: (...args) => mockGetSharedLinkExpiration(...args),
  isActiveExpirationDate: jest.fn((expiredAt) => expiredAt > new Date()),
  /* The list/query helpers are behaviour-tested in `@librechat/api`; the route only has
     to be wired to them, so they stand in as doubles here. */
  parseSharedLinksPageSize: (...args) => mockParseSharedLinksPageSize(...args),
  isValidSharedLinksCursor: (...args) => mockIsValidSharedLinksCursor(...args),
  buildShareFileEtag: (file) =>
    `"share-${file.file_id}-${file.previewRevision ?? 0}-${file.bytes ?? 0}-${file.filepath ?? ''}"`,
  MAX_SHARED_LINK_SEARCH_LENGTH: 256,
  createSharedLangfuseSessionResolver: jest.fn(
    () =>
      (...args) =>
        mockGetSharedLangfuseSessionUrl(...args),
  ),
  recordShareLinkRejection: (...args) => mockRecordShareLinkRejection(...args),
  traceIdForMessage: (messageId) => `trace-${messageId}`,
  isContentFilterError: jest.fn(
    (error) =>
      error?.code === 'content_filter_block' || error?.code === 'content_filter_uninspectable',
  ),
  isConversationImportError: jest.fn((error) => error?.name === 'ConversationImportError'),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
  createChatExpirationDate: jest.fn(() => new Date('2030-01-01T00:00:00.000Z')),
  runAsSystem: jest.fn((fn) => fn()),
  tenantStorage: {
    getStore: jest.fn(() => ({ requestId: 'request-123' })),
    run: jest.fn((_ctx, fn) => fn()),
  },
  SYSTEM_TENANT_ID: '__SYSTEM__',
  SystemCapabilities: { ACCESS_ADMIN: 'access:admin' },
}));

jest.mock('librechat-data-provider', () => ({
  PermissionTypes: {
    SHARED_LINKS: 'SHARED_LINKS',
  },
  Permissions: {
    CREATE: 'CREATE',
    SHARE_PUBLIC: 'SHARE_PUBLIC',
  },
  RetentionMode: {
    ALL: 'all',
    TEMPORARY: 'temporary',
  },
  FileSources: {
    local: 'local',
    s3: 's3',
    cloudfront: 'cloudfront',
    azure_blob: 'azure_blob',
    firebase: 'firebase',
    text: 'text',
  },
}));

jest.mock('mongoose', () => ({
  models: {
    Conversation: {
      findOne: jest.fn(),
    },
    SharedLink: {
      findOne: jest.fn(),
    },
  },
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn(),
  updateFile: jest.fn(),
  getSharedMessages: jest.fn(),
  createSharedLink: jest.fn(),
  updateSharedLink: jest.fn(),
  deleteSharedLink: jest.fn(),
  getSharedLinks: jest.fn(),
  getSharedLink: jest.fn(),
  getSharedLinkFile: jest.fn(),
  backfillSharedLinkFiles: jest.fn(),
  getMessages: jest.fn(),
  getRoleByName: jest.fn(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: (...args) => mockHasCapability(...args),
  hasConfigCapability: (...args) => mockHasConfigCapability(...args),
}));

const mockGetStrategyFunctions = jest.fn();
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: (...args) => mockGetStrategyFunctions(...args),
}));
jest.mock('~/server/utils/files', () => ({
  cleanFileName: jest.fn((name) => name),
  getContentDisposition: jest.fn((name, disposition = 'attachment') => `${disposition}; ${name}`),
}));

jest.mock(
  '~/server/middleware/canAccessSharedLink',
  () =>
    (...args) =>
      mockCanAccessSharedLink(...args),
);
jest.mock('~/server/middleware/optionalShareFileAuth', () => (_req, _res, next) => next());
jest.mock('~/server/middleware/optionalJwtAuth', () => (req, _res, next) => next());
jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());
jest.mock('~/server/middleware/config/app', () => (_req, _res, next) => next());
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/middleware/limiters', () => ({
  createForkLimiters: () => ({
    forkIpLimiter: (_req, _res, next) => next(),
    forkUserLimiter: (_req, _res, next) => next(),
  }),
  createShareLimiters: () => ({
    shareIpLimiter: (req, res, next) => mockShareIpLimiter(req, res, next),
    shareUserLimiter: (req, res, next) => mockShareUserLimiter(req, res, next),
  }),
}));

jest.mock('~/server/utils/import/fork', () => ({
  forkSharedConversation: jest.fn(),
}));
jest.mock('~/server/utils/import/importBatchBuilder', () => ({
  assertConversationContentAllowed: (...args) => mockAssertConversationContentAllowed(...args),
}));

const { Readable } = require('stream');
const { RetentionMode } = require('librechat-data-provider');
const { createChatExpirationDate, logger } = require('@librechat/data-schemas');
const {
  deleteSharedLinkWithCleanup,
  isFileSnapshotEnabled,
  isFileSnapshotKillSwitchActive,
} = require('@librechat/api');
const {
  getFiles,
  updateFile,
  getSharedMessages,
  createSharedLink,
  updateSharedLink,
  getSharedLinks,
  getSharedLinkFile,
  backfillSharedLinkFiles,
  getRoleByName,
} = require('~/models');
const { forkSharedConversation } = require('~/server/utils/import/fork');
const shareRouter = require('../share');

const activeExpiration = new Date('2030-01-01T00:00:00.000Z');
const expiredExpiration = new Date('2020-01-01T00:00:00.000Z');
const contentFilters = {
  messages: {
    pii: {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    },
  },
};

const lean = (value) => ({
  lean: jest.fn().mockResolvedValue(value),
});

const buildApp = ({
  retentionMode = RetentionMode.TEMPORARY,
  user = { id: 'user-123' },
  filters,
  messageFilter,
  langfuse,
} = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    req.config = {
      interfaceConfig: { retentionMode },
      ...(filters == null ? {} : { filters }),
      ...(messageFilter == null ? {} : { messageFilter }),
      ...(langfuse == null ? {} : { langfuse }),
    };
    next();
  });
  app.use('/api/share', shareRouter);
  return app;
};

const mockSharedMessagesResult = (result) => {
  getSharedMessages.mockImplementation(async (_shareId, _resourceId, options) => {
    await options?.preflight?.(result);
    return result;
  });
};

const mockUpdatedShare = (result) => {
  updateSharedLink.mockImplementationOnce(async (...args) => {
    await args[5]?.({ title: 'Safe share', messages: [] });
    await args[6]?.();
    return result;
  });
};

const useResolvedSharedLinkConfig = () => {
  mockSharedLinkConfigMiddleware.mockImplementationOnce(async (req, _res, next) => {
    const tenantId = req.shareTenantId;
    req.config = await mockGetAppConfig(
      tenantId && tenantId !== '__SYSTEM__' ? { tenantId } : { baseOnly: true },
    );
    next();
  });
};

describe('share routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShareTenantId = undefined;
    mockHasCapability.mockResolvedValue(false);
    mockHasConfigCapability.mockResolvedValue(false);
    mockGetSharedLangfuseSessionUrl.mockResolvedValue(null);
    mockGetAppConfig.mockResolvedValue({
      interfaceConfig: {
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      },
    });
    mockBuildSharedLinkStartupPayload.mockReturnValue({
      appTitle: 'Shared Chat',
      bundlerURL: 'https://bundler.example.com',
      interface: {
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      },
    });
    getRoleByName.mockResolvedValue({
      permissions: {
        SHARED_LINKS: {
          SHARE_PUBLIC: true,
        },
      },
    });
    mockGrantCreationPermissions.mockResolvedValue(undefined);
  });

  it('serves shared startup config after shared-link access is granted', async () => {
    useResolvedSharedLinkConfig();
    const response = await request(buildApp()).get('/api/share/share-123/config');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(mockCanAccessSharedLink).toHaveBeenCalled();
    expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(mockBuildSharedLinkStartupPayload).toHaveBeenCalledWith({
      interfaceConfig: {
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      },
    });
    expect(response.body).toEqual({
      appTitle: 'Shared Chat',
      bundlerURL: 'https://bundler.example.com',
      interface: {
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      },
    });
  });

  it('uses tenant-scoped app config for shared startup config when tenant context is present', async () => {
    mockShareTenantId = 'tenant-abc';
    useResolvedSharedLinkConfig();

    const response = await request(buildApp()).get('/api/share/share-123/config');

    expect(response.status).toBe(200);
    expect(mockGetAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-abc' });
  });

  it('uses base app config for shared startup config in system context', async () => {
    mockShareTenantId = '__SYSTEM__';
    useResolvedSharedLinkConfig();

    const response = await request(buildApp()).get('/api/share/share-123/config');

    expect(response.status).toBe(200);
    expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('rate limits shared message retrieval by IP and by user', async () => {
    mockSharedMessagesResult({ shareId: 'share-123', messages: [] });

    await request(buildApp()).get('/api/share/share-123').expect(200);

    expect(mockShareIpLimiter).toHaveBeenCalledTimes(1);
    expect(mockShareUserLimiter).toHaveBeenCalledTimes(1);
  });

  it('prevents successful shared message responses from being cached', async () => {
    mockSharedMessagesResult({ shareId: 'share-123', messages: [] });

    const response = await request(buildApp()).get('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(mockAssertConversationContentAllowed).not.toHaveBeenCalled();
    expect(mockAssertSharedFileMetadataAllowed).not.toHaveBeenCalled();
  });

  it('includes the source conversation session for an admin in the share tenant', async () => {
    mockShareTenantId = 'tenant-abc';
    mockGetSharedLangfuseSessionUrl.mockResolvedValue(
      'https://cloud.langfuse.com/project/project-1/sessions/conversation-owner-123',
    );
    mockSharedMessagesResult({ shareId: 'share-123', messages: [] });
    const langfuse = { enabled: true, destination: 'eu', projectId: 'project-1' };

    const response = await request(
      buildApp({
        user: { id: 'admin-123', role: 'ADMIN', tenantId: 'tenant-abc' },
        langfuse,
      }),
    ).get('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(response.body.langfuseSessionUrl).toBe(
      'https://cloud.langfuse.com/project/project-1/sessions/conversation-owner-123',
    );
    expect(mockGetSharedLangfuseSessionUrl).toHaveBeenCalledWith({
      viewer: expect.objectContaining({ id: 'admin-123', tenantId: 'tenant-abc' }),
      shareTenantId: 'tenant-abc',
      shareConversationId: 'conversation-owner-123',
      shareOwnerId: 'owner-123',
      config: langfuse,
    });
  });

  it('omits the session link when the shared-session resolver denies access', async () => {
    mockShareTenantId = 'tenant-abc';
    mockSharedMessagesResult({ shareId: 'share-123', messages: [] });

    const response = await request(
      buildApp({ user: { id: 'user-123', role: 'USER', tenantId: 'tenant-abc' } }),
    ).get('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('langfuseSessionUrl');
  });

  it('serves the shared chat when session-link resolution fails', async () => {
    mockShareTenantId = 'tenant-abc';
    mockGetSharedLangfuseSessionUrl.mockRejectedValue(new Error('Langfuse lookup failed'));
    mockSharedMessagesResult({ shareId: 'share-123', messages: [] });

    const response = await request(
      buildApp({ user: { id: 'admin-123', role: 'ADMIN', tenantId: 'tenant-abc' } }),
    ).get('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('langfuseSessionUrl');
    expect(logger.warn).toHaveBeenCalledWith(
      '[share] Failed to resolve Langfuse session link:',
      expect.any(Error),
    );
  });

  it('resolves the session link while loading the shared snapshot', async () => {
    let resolveShare;
    let markShareStarted;
    const shareStarted = new Promise((resolve) => {
      markShareStarted = resolve;
    });
    const pendingShare = new Promise((resolve) => {
      resolveShare = resolve;
    });
    getSharedMessages.mockImplementationOnce(() => {
      markShareStarted();
      return pendingShare;
    });
    mockGetSharedLangfuseSessionUrl.mockResolvedValue(null);

    const responsePromise = request(buildApp())
      .get('/api/share/share-123')
      .then((response) => response);
    await shareStarted;

    expect(mockGetSharedLangfuseSessionUrl).toHaveBeenCalledTimes(1);
    resolveShare({ shareId: 'share-123', messages: [] });
    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
  });

  it('normalizes shared-link list parameters without double-decoding search text', async () => {
    getSharedLinks.mockResolvedValue({ links: [], hasNextPage: false });
    mockParseSharedLinksPageSize.mockReturnValueOnce(100);
    const cursor = '2030-01-01T00:00:00.000Z';

    const response = await request(buildApp()).get(
      `/api/share?pageSize=1000&sortBy=createdAt&sortDirection=asc&search=100%25%20ready&cursor=${encodeURIComponent(cursor)}`,
    );

    expect(response.status).toBe(200);
    expect(getSharedLinks).toHaveBeenCalledWith(
      'user-123',
      cursor,
      100,
      'createdAt',
      'asc',
      '100% ready',
    );
  });

  it('rejects a cursor the validator refuses before querying', async () => {
    mockIsValidSharedLinksCursor.mockReturnValueOnce(false);

    const response = await request(buildApp()).get('/api/share?cursor=not-a-date');

    expect(response.status).toBe(400);
    expect(mockIsValidSharedLinksCursor).toHaveBeenCalledWith('not-a-date', 'createdAt');
    expect(getSharedLinks).not.toHaveBeenCalled();
  });

  it('accepts the composite cursor issued for a titleless page', async () => {
    getSharedLinks.mockResolvedValue({ links: [], hasNextPage: false });
    const cursor = Buffer.from(
      JSON.stringify({ primary: null, id: '0123456789abcdef01234567' }),
    ).toString('base64');

    const response = await request(buildApp()).get(
      `/api/share?sortBy=title&cursor=${encodeURIComponent(cursor)}`,
    );

    expect(response.status).toBe(200);
    expect(getSharedLinks).toHaveBeenCalledWith('user-123', cursor, 10, 'title', 'desc', undefined);
  });

  it('does not expose internal list errors in the response', async () => {
    getSharedLinks.mockRejectedValue(new Error('mongodb.internal:27017'));

    const response = await request(buildApp()).get('/api/share');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Error getting shared links' });
  });

  it('reapplies the current content policy before serving an existing share', async () => {
    const share = {
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [
        {
          text: 'safe message',
          files: [{ file_id: 'file-1', filename: 'safe-report.pdf' }],
          attachments: [{ file_id: 'file-2', name: 'safe-image.png' }],
          content: [
            {
              type: 'steer',
              steer: 'safe user steer',
              files: [{ file_id: 'file-3', filename: 'safe-context.txt' }],
            },
          ],
        },
      ],
    };
    mockSharedMessagesResult(share);

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(200);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(contentFilters, {
      conversations: [{ title: share.title }],
      messages: [
        {
          text: 'safe message',
          content: [{ type: 'steer', steer: 'safe user steer' }],
        },
      ],
    });
    expect(mockAssertSharedFileMetadataAllowed).toHaveBeenCalledWith({
      filters: contentFilters,
      messages: share.messages,
      shareId: 'share-123',
    });
  });

  it('uses the share tenant policy when an authenticated viewer belongs to another tenant', async () => {
    const ownerFilters = {
      messages: {
        pii: {
          starterPatterns: ['sk_prefix'],
        },
      },
    };
    const share = {
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [{ isCreatedByUser: true, text: 'safe message' }],
    };
    mockShareTenantId = 'tenant-owner';
    mockSharedLinkConfigMiddleware.mockImplementationOnce((req, _res, next) => {
      expect(req.user.tenantId).toBe('tenant-viewer');
      expect(req.shareTenantId).toBe('tenant-owner');
      req.config = { filters: ownerFilters };
      next();
    });
    mockSharedMessagesResult(share);

    const response = await request(
      buildApp({ user: { id: 'viewer', role: 'USER', tenantId: 'tenant-viewer' } }),
    ).get('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(ownerFilters, {
      conversations: [{ title: share.title }],
      messages: share.messages,
    });
    expect(mockAssertSharedFileMetadataAllowed).toHaveBeenCalledWith({
      filters: ownerFilters,
      messages: share.messages,
      shareId: share.shareId,
    });
  });

  it('threads a legacy-only detector into strict shared-content preflight', async () => {
    const strictFilters = {
      messages: { unattributedAssistantContent: 'inspect' },
    };
    const legacyPii = {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    };
    const share = {
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [{ isCreatedByUser: false, role: 'assistant', text: 'safe model output' }],
    };
    mockSharedMessagesResult(share);

    const response = await request(
      buildApp({ filters: strictFilters, messageFilter: { pii: legacyPii } }),
    ).get('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      strictFilters,
      {
        conversations: [{ title: share.title }],
        messages: share.messages,
      },
      { legacyPii },
    );
  });

  it('keeps shared-message preflight active with only legacy message filtering', async () => {
    const legacyPii = { starterPatterns: ['sk_prefix'] };
    const share = {
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [{ isCreatedByUser: true, text: 'safe user input' }],
    };
    mockSharedMessagesResult(share);

    const response = await request(buildApp({ messageFilter: { pii: legacyPii } })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(200);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      undefined,
      {
        conversations: [{ title: share.title }],
        messages: share.messages,
      },
      { legacyPii },
    );
  });

  it('returns a raw-free 400 when existing shared metadata fails current policy', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'attachment_reference',
      },
    });
    mockSharedMessagesResult({
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [
        {
          text: 'safe message',
          files: [{ file_id: 'file-1', filename: 'PRIVATE-SENTINEL.pdf' }],
        },
      ],
    });
    mockAssertSharedFileMetadataAllowed.mockImplementationOnce(() => {
      throw error;
    });

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rechecks legacy shared response fields before returning public JSON', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'attachment_reference',
      },
    });
    const share = {
      shareId: 'share-123',
      title: 'Legacy Shared Conversation',
      messages: [
        {
          isCreatedByUser: true,
          text: 'safe message',
          iconURL: 'https://example.test/PRIVATE-SENTINEL',
        },
      ],
    };
    mockSharedMessagesResult(share);
    mockAssertSharedFileMetadataAllowed.mockImplementationOnce(() => {
      throw error;
    });

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(mockAssertSharedFileMetadataAllowed).toHaveBeenCalledWith({
      filters: contentFilters,
      messages: share.messages,
      shareId: share.shareId,
    });
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns a raw-free 400 when an existing share fails the current policy', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'text',
      },
    });
    mockSharedMessagesResult({
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [{ text: 'PRIVATE-SENTINEL' }],
    });
    mockAssertConversationContentAllowed.mockImplementationOnce(() => {
      throw error;
    });

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('expires new shares for retained non-temporary conversations', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    const response = await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123' });

    expect(response.status).toBe(200);
    expect(mockGetSharedLinkExpiration).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'convo-123',
        req: expect.objectContaining({ user: { id: 'user-123' } }),
      }),
      expect.objectContaining({
        getConvo: expect.any(Function),
        createExpirationDate: createChatExpirationDate,
        logger,
      }),
    );
    const [, dependencies] = mockGetSharedLinkExpiration.mock.calls[0];
    mongoose.models.Conversation.findOne.mockReturnValue(lean({ expiredAt: activeExpiration }));
    await dependencies.getConvo('user-123', 'convo-123');
    expect(mongoose.models.Conversation.findOne).toHaveBeenCalledWith(
      { conversationId: 'convo-123', user: 'user-123' },
      'isTemporary expiredAt',
    );
    expect(createSharedLink).toHaveBeenCalledWith(
      'user-123',
      'convo-123',
      'msg-123',
      new Date('2030-01-01T00:00:00.000Z'),
      true,
    );
    expect(mockGrantCreationPermissions).toHaveBeenCalledWith(
      'link-123',
      'user-123',
      true,
      new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(mockSharedLinksAccess).toHaveBeenCalled();
  });

  it('snapshots files by default when the user does not opt out', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    await request(buildApp()).post('/api/share/convo-123').send({ targetMessageId: 'msg-123' });

    expect(createSharedLink).toHaveBeenCalledWith(
      'user-123',
      'convo-123',
      'msg-123',
      expect.anything(),
      true,
    );
  });

  it('rejects invalid create options before resolving retention', async () => {
    const invalidTarget = await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: '' });
    const invalidSnapshot = await request(buildApp())
      .post('/api/share/convo-123')
      .send({ snapshotFiles: 'false' });

    expect(invalidTarget.status).toBe(400);
    expect(invalidSnapshot.status).toBe(400);
    expect(mockGetSharedLinkExpiration).not.toHaveBeenCalled();
    expect(createSharedLink).not.toHaveBeenCalled();
  });

  it('maps an existing-share domain error to conflict', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockRejectedValue(
      Object.assign(new Error('Share already exists'), { code: 'SHARE_EXISTS' }),
    );

    const response = await request(buildApp()).post('/api/share/convo-123').send({});

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ message: 'Share already exists', code: 'SHARE_EXISTS' });
  });

  it.each([
    ['TARGET_MESSAGE_NOT_FOUND', 'Target message not found', 'trace-msg-123'],
    ['NO_MESSAGES', 'No messages to share', 'trace-msg-123'],
  ])('returns and records the %s create rejection', async (code, message, traceId) => {
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockRejectedValue(Object.assign(new Error(message), { code }));

    const response = await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message, code });
    expect(mockRecordShareLinkRejection).toHaveBeenCalledWith('create', code);
    expect(logger.warn).toHaveBeenCalledWith('[share] Shared link publication rejected', {
      event: 'share_link_rejected',
      operation: 'create',
      code,
      request_id: 'request-123',
      trace_id: traceId,
    });
    expect(logger.error).not.toHaveBeenCalledWith('Error creating shared link:', expect.anything());
  });

  it('returns a raw-free 400 when the exact create snapshot fails policy preflight', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'text',
      },
    });
    const messages = [{ text: 'PRIVATE-SENTINEL' }];
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockAssertConversationContentAllowed.mockImplementationOnce(() => {
      throw error;
    });
    createSharedLink.mockImplementationOnce(async (...args) => {
      await args[5]({ title: 'Protected Conversation', messages });
      return { _id: 'link-123', shareId: 'share-123' };
    });

    const response = await request(buildApp({ filters: contentFilters }))
      .post('/api/share/convo-123')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      contentFilters,
      {
        conversations: [{ title: 'Protected Conversation' }],
        messages,
      },
      {
        user: { id: 'user-123' },
        getFiles,
      },
    );
    expect(mockGrantCreationPermissions).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('checks public message metadata before creating the shared link', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'attachment_reference',
      },
    });
    const messages = [
      {
        isCreatedByUser: true,
        text: 'safe message',
        iconURL: 'https://example.test/PRIVATE-SENTINEL',
      },
    ];
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockAssertSharedFileMetadataAllowed.mockImplementationOnce(() => {
      throw error;
    });
    createSharedLink.mockImplementationOnce(async (...args) => {
      await args[5]({ title: 'Protected Conversation', messages });
      return { _id: 'link-123', shareId: 'share-123' };
    });

    const response = await request(buildApp({ filters: contentFilters }))
      .post('/api/share/convo-123')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      contentFilters,
      {
        conversations: [{ title: 'Protected Conversation' }],
        messages,
      },
      {
        user: { id: 'user-123' },
        getFiles,
      },
    );
    expect(mockAssertSharedFileMetadataAllowed).toHaveBeenCalledWith({
      filters: contentFilters,
      messages,
      shareId: undefined,
      includeFiles: false,
    });
    expect(mockGrantCreationPermissions).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('preflights only the exact text snapshot when shared files are opted out', async () => {
    const messages = [
      {
        text: 'safe message',
        files: [{ file_id: 'file-top-level' }],
        attachments: [{ file_id: 'attachment-top-level' }],
        content: [
          { type: 'text', text: 'safe model content' },
          {
            type: 'steer',
            steer: 'safe user steer',
            files: [{ file_id: 'steer-file' }],
          },
        ],
      },
    ];
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockImplementationOnce(async (...args) => {
      await args[5]({ title: 'Protected Conversation', messages });
      return { _id: 'link-123', shareId: 'share-123' };
    });

    const response = await request(buildApp({ filters: contentFilters }))
      .post('/api/share/convo-123')
      .send({ snapshotFiles: false });

    expect(response.status).toBe(200);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      contentFilters,
      {
        conversations: [{ title: 'Protected Conversation' }],
        messages: [
          {
            text: 'safe message',
            content: [
              { type: 'text', text: 'safe model content' },
              { type: 'steer', steer: 'safe user steer' },
            ],
          },
        ],
      },
      {
        user: { id: 'user-123' },
        getFiles,
      },
    );
  });

  it('does not snapshot files when the user opts out (snapshotFiles=false)', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123', snapshotFiles: false });

    expect(createSharedLink).toHaveBeenCalledWith(
      'user-123',
      'convo-123',
      'msg-123',
      expect.anything(),
      false,
    );
  });

  it('forces snapshotFiles=false when the feature is disabled, ignoring the body flag', async () => {
    isFileSnapshotEnabled.mockReturnValueOnce(false);
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123', snapshotFiles: true });

    expect(createSharedLink).toHaveBeenCalledWith(
      'user-123',
      'convo-123',
      'msg-123',
      expect.anything(),
      false,
    );
  });

  it('passes the snapshotFiles opt-out through on update', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockUpdatedShare({ _id: 'link-456', shareId: 'share-456' });

    await request(buildApp()).patch('/api/share/share-123').send({ snapshotFiles: false });

    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      undefined,
      expect.anything(),
      false,
      undefined,
      expect.any(Function),
    );
  });

  it('returns a raw-free 400 when the exact update snapshot fails policy preflight', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'content',
      },
    });
    const messages = [{ files: [{ file_id: 'file_PRIVATE-SENTINEL' }] }];
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockAssertConversationContentAllowed.mockImplementationOnce(() => {
      throw error;
    });
    updateSharedLink.mockImplementationOnce(async (...args) => {
      await args[5]({ title: 'Protected Share', messages });
      await args[6]?.();
      return { _id: 'link-456', shareId: 'share-456' };
    });

    const response = await request(buildApp({ filters: contentFilters })).patch(
      '/api/share/share-123',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      contentFilters,
      {
        conversations: [{ title: 'Protected Share' }],
        messages,
      },
      {
        user: { id: 'user-123' },
        getFiles,
      },
    );
    expect(mockUpdateSharedLinkPermissionsExpiration).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rejects new shares when the retained conversation expired', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(expiredExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    const response = await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123' });

    expect(response.status).toBe(404);
    expect(createSharedLink).not.toHaveBeenCalled();
  });

  it('rejects new shares for expired conversations in all retention mode', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(expiredExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    const response = await request(buildApp({ retentionMode: RetentionMode.ALL }))
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123' });

    expect(response.status).toBe(404);
    expect(createSharedLink).not.toHaveBeenCalled();
  });

  it('expires updated shares for retained non-temporary conversations', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockUpdatedShare({ _id: 'link-456', shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(mongoose.models.SharedLink.findOne).toHaveBeenCalledWith(
      { shareId: 'share-123', user: 'user-123' },
      'conversationId',
    );
    expect(mockGetSharedLinkExpiration).toHaveBeenCalledTimes(1);
    expect(mockGetSharedLinkExpiration).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'convo-123',
        req: expect.objectContaining({ user: { id: 'user-123' } }),
      }),
      expect.objectContaining({
        getConvo: expect.any(Function),
        createExpirationDate: createChatExpirationDate,
        logger,
      }),
    );
    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      undefined,
      new Date('2030-01-01T00:00:00.000Z'),
      true,
      undefined,
      expect.any(Function),
    );
    expect(mockUpdateSharedLinkPermissionsExpiration).toHaveBeenCalledWith(
      'link-456',
      new Date('2030-01-01T00:00:00.000Z'),
    );
  });

  it('does not re-publish content when re-scoping the grants fails', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockUpdateSharedLinkPermissionsExpiration.mockRejectedValueOnce(new Error('acl down'));
    mockUpdatedShare({ _id: 'link-456', shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(500);
    // The shareId is stable, so publishing first would expose the update behind
    // the existing grants while the owner is told the update failed.
    expect(updateSharedLink).toHaveBeenCalledTimes(1);
  });

  it('rejects updated shares when the retained conversation expired', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockResolvedValue(expiredExpiration);
    updateSharedLink.mockResolvedValue({ shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(404);
    expect(updateSharedLink).not.toHaveBeenCalled();
  });

  it('rejects updated shares for expired conversations in all retention mode', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockResolvedValue(expiredExpiration);
    updateSharedLink.mockResolvedValue({ shareId: 'share-456' });

    const response = await request(buildApp({ retentionMode: RetentionMode.ALL })).patch(
      '/api/share/share-123',
    );

    expect(response.status).toBe(404);
    expect(mongoose.models.SharedLink.findOne).toHaveBeenCalledWith(
      { shareId: 'share-123', user: 'user-123' },
      'conversationId',
    );
    expect(updateSharedLink).not.toHaveBeenCalled();
  });

  it('clears updated share expiration when the conversation is no longer retained', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockResolvedValue(null);
    mockUpdatedShare({ _id: 'link-456', shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      undefined,
      null,
      true,
      undefined,
      expect.any(Function),
    );
    expect(mockUpdateSharedLinkPermissionsExpiration).toHaveBeenCalledWith('link-456', null);
    expect(mockSharedLinksAccess).toHaveBeenCalled();
  });

  it('gates updates on the CREATE permission so revoking it stops link updates', async () => {
    mockSharedLinksAccess.mockImplementationOnce((_req, res) =>
      res.status(403).json({ message: 'Forbidden' }),
    );

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(403);
    expect(updateSharedLink).not.toHaveBeenCalled();
  });

  it('preserves updated share expiration when the conversation cannot be found', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockResolvedValue(undefined);
    mockUpdatedShare({ shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      undefined,
      undefined,
      true,
      undefined,
      undefined,
    );
    expect(mockUpdateSharedLinkPermissionsExpiration).not.toHaveBeenCalled();
  });

  it('clears updated share expiration when creating a new expiration throws', async () => {
    const error = new Error('bad config');
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockImplementationOnce(async (_input, dependencies) => {
      dependencies.logger.error('[getSharedLinkExpiration] Error creating expiration date:', error);
      return null;
    });
    mockUpdatedShare({ _id: 'link-456', shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      '[getSharedLinkExpiration] Error creating expiration date:',
      error,
    );
    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      undefined,
      null,
      true,
      undefined,
      expect.any(Function),
    );
    expect(mockUpdateSharedLinkPermissionsExpiration).toHaveBeenCalledWith('link-456', null);
  });

  it('updates share target message while applying retention expiration', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(
      lean({ _id: 'link-456', conversationId: 'convo-123' }),
    );
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockUpdatedShare({ shareId: 'share-456', targetMessageId: 'msg-456' });

    const response = await request(buildApp())
      .patch('/api/share/share-123')
      .send({ targetMessageId: 'msg-456' });

    expect(response.status).toBe(200);
    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      'msg-456',
      new Date('2030-01-01T00:00:00.000Z'),
      true,
      undefined,
      expect.any(Function),
    );
  });

  it('rejects non-string target message updates', async () => {
    const response = await request(buildApp())
      .patch('/api/share/share-123')
      .send({ targetMessageId: 123 });

    expect(response.status).toBe(400);
    expect(updateSharedLink).not.toHaveBeenCalled();
  });

  it('rejects invalid snapshot options on update', async () => {
    const response = await request(buildApp())
      .patch('/api/share/share-123')
      .send({ snapshotFiles: 'false' });

    expect(response.status).toBe(400);
    expect(updateSharedLink).not.toHaveBeenCalled();
  });

  it('maps a missing-share update domain error to not found', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(lean(null));
    updateSharedLink.mockRejectedValue(
      Object.assign(new Error('Share not found'), { code: 'SHARE_NOT_FOUND' }),
    );

    const response = await request(buildApp()).patch('/api/share/share-123').send({});

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Share not found', code: 'SHARE_NOT_FOUND' });
  });

  it('returns and records a missing-tail update rejection', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    updateSharedLink.mockRejectedValue(
      Object.assign(new Error('Target message not found'), {
        code: 'TARGET_MESSAGE_NOT_FOUND',
      }),
    );

    const response = await request(buildApp())
      .patch('/api/share/share-123')
      .send({ targetMessageId: 'msg-123' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      message: 'Target message not found',
      code: 'TARGET_MESSAGE_NOT_FOUND',
    });
    expect(mockRecordShareLinkRejection).toHaveBeenCalledWith('update', 'TARGET_MESSAGE_NOT_FOUND');
    expect(logger.warn).toHaveBeenCalledWith('[share] Shared link publication rejected', {
      event: 'share_link_rejected',
      operation: 'update',
      code: 'TARGET_MESSAGE_NOT_FOUND',
      request_id: 'request-123',
      trace_id: 'trace-msg-123',
    });
  });

  it('allows deleting existing shares without CREATE permission gate', async () => {
    deleteSharedLinkWithCleanup.mockResolvedValue({ shareId: 'share-123' });

    const response = await request(buildApp()).delete('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(mockSharedLinksAccess).not.toHaveBeenCalled();
    expect(deleteSharedLinkWithCleanup).toHaveBeenCalledWith('user-123', 'share-123');
  });

  it('returns an internal error status when deletion fails', async () => {
    deleteSharedLinkWithCleanup.mockRejectedValue(new Error('database unavailable'));

    const response = await request(buildApp()).delete('/api/share/share-123');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Error deleting shared link' });
  });
});

describe('share fork route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShareTenantId = undefined;
  });

  it('forks a shared conversation for the requesting user', async () => {
    const forkResult = {
      conversation: { conversationId: 'convo-456', title: 'Shared Title' },
      messages: [{ messageId: 'msg-456' }],
    };
    forkSharedConversation.mockResolvedValue(forkResult);

    const response = await request(
      buildApp({ user: { id: 'user-123', role: 'USER', tenantId: 'tenant-viewer' } }),
    )
      .post('/api/share/share-123/fork')
      .send({ targetMessageIndex: 3, shareRevision: '2026-01-01T00:00:00.000Z' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(forkResult);
    expect(forkSharedConversation).toHaveBeenCalledWith({
      shareId: 'share-123',
      shareResourceId: 'resource-123',
      requestUserId: 'user-123',
      userRole: 'USER',
      userTenantId: 'tenant-viewer',
      targetMessageIndex: 3,
      shareRevision: '2026-01-01T00:00:00.000Z',
      snapshotFiles: true,
      sharedContentPreflight: undefined,
    });
  });

  it('passes the share tenant policy into a cross-tenant fork read preflight', async () => {
    const share = {
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [{ text: 'safe', files: [{ filename: 'safe-report.pdf' }] }],
    };
    forkSharedConversation.mockImplementationOnce(async ({ sharedContentPreflight }) => {
      await sharedContentPreflight(share);
      return {
        conversation: { conversationId: 'convo-456' },
        messages: [],
      };
    });
    mockShareTenantId = 'tenant-owner';
    mockSharedLinkConfigMiddleware.mockImplementationOnce((req, _res, next) => {
      expect(req.user.tenantId).toBe('tenant-viewer');
      expect(req.shareTenantId).toBe('tenant-owner');
      req.config = { filters: contentFilters };
      next();
    });

    const response = await request(
      buildApp({ user: { id: 'viewer', role: 'USER', tenantId: 'tenant-viewer' } }),
    ).post('/api/share/share-123/fork');

    expect(response.status).toBe(201);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(contentFilters, {
      conversations: [{ title: share.title }],
      messages: [{ text: 'safe' }],
    });
    expect(mockAssertSharedFileMetadataAllowed).toHaveBeenCalledWith({
      filters: contentFilters,
      messages: share.messages,
      shareId: share.shareId,
    });
  });

  it('forces snapshotFiles=false into the fork when the file snapshot kill switch is active', async () => {
    isFileSnapshotKillSwitchActive.mockReturnValueOnce(true);
    forkSharedConversation.mockResolvedValue({
      conversation: { conversationId: 'convo-456' },
      messages: [],
    });

    await request(buildApp()).post('/api/share/share-123/fork');

    expect(forkSharedConversation).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotFiles: false }),
    );
  });

  it('returns 404 when the shared conversation is missing or empty', async () => {
    forkSharedConversation.mockResolvedValue(null);

    const response = await request(buildApp()).post('/api/share/share-123/fork');

    expect(response.status).toBe(404);
  });

  it('returns 500 when forking fails', async () => {
    forkSharedConversation.mockRejectedValue(new Error('db down'));

    const response = await request(buildApp()).post('/api/share/share-123/fork');

    expect(response.status).toBe(500);
  });

  it('returns an actionable client error when a cloned record is oversized', async () => {
    const message = 'Each imported conversation or message must be at most 16711680 bytes';
    const error = Object.assign(new Error(message), {
      name: 'ConversationImportError',
      code: 'invalid_request',
      statusCode: 413,
      body: { error: 'invalid_request', message },
    });
    forkSharedConversation.mockRejectedValue(error);

    const response = await request(buildApp()).post('/api/share/share-123/fork');

    expect(response.status).toBe(413);
    expect(response.body).toEqual(error.body);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers 409 when the viewer forks a payload the owner has republished', async () => {
    const conflict = new Error('Shared link was updated');
    conflict.code = 'SHARE_REVISION_MISMATCH';
    forkSharedConversation.mockRejectedValue(conflict);

    const response = await request(buildApp())
      .post('/api/share/share-123/fork')
      .send({ targetMessageIndex: 3, shareRevision: '2026-01-01T00:00:00.000Z' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      message: 'Shared link was updated',
      code: 'SHARE_REVISION_MISMATCH',
    });
  });
});

describe('share-scoped file routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShareTenantId = undefined;
    mockGetStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn(async () => Readable.from(['file-bytes'])),
    });
    // Live file record present by default (resolveShareFile requires it).
    getFiles.mockResolvedValue([{ status: 'ready' }]);
  });

  it('serves a snapshotted image inline from its original stored object', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['file-bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/images/owner/pic.png',
        type: 'image/png',
        filename: 'pic.png',
      },
      hasSnapshots: true,
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toContain('inline');
    expect(mockGetStrategyFunctions).toHaveBeenCalledWith('local');
    expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), '/images/owner/pic.png');
    expect(backfillSharedLinkFiles).not.toHaveBeenCalled();
  });

  it('requires revalidation so a revoked link cannot be served from cache', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['file-bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/images/owner/pic.png',
        type: 'image/png',
        filename: 'pic.png',
        bytes: 1234,
      },
      hasSnapshots: true,
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    // The shareId is stable across updates now, so the URL alone can no longer bust caches.
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.headers['etag']).toBeDefined();
  });

  it('answers an unchanged snapshot with 304 instead of re-sending bytes', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['file-bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/images/owner/pic.png',
        type: 'image/png',
        filename: 'pic.png',
        bytes: 1234,
      },
      hasSnapshots: true,
    });

    const app = buildApp();
    const first = await request(app).get('/api/share/share-123/files/file-1');
    expect(first.status).toBe(200);

    getDownloadStream.mockClear();
    const response = await request(app)
      .get('/api/share/share-123/files/file-1')
      .set('If-None-Match', first.headers['etag']);

    expect(response.status).toBe(304);
    expect(getDownloadStream).not.toHaveBeenCalled();
  });

  it('changes the validator when the snapshot revision moves', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['file-bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    const snapshot = {
      file_id: 'file-1',
      source: 'local',
      filepath: '/images/owner/pic.png',
      type: 'image/png',
      filename: 'pic.png',
      bytes: 1234,
    };
    getSharedLinkFile.mockResolvedValue({ file: snapshot, hasSnapshots: true });

    const app = buildApp();
    const first = await request(app).get('/api/share/share-123/files/file-1');

    // Must match the snapshot, or resolveShareFile 404s on the version mismatch first.
    getFiles.mockResolvedValue([{ status: 'ready', previewRevision: 7, bytes: 1234 }]);
    getSharedLinkFile.mockResolvedValue({
      file: { ...snapshot, previewRevision: 7 },
      hasSnapshots: true,
    });

    const response = await request(app)
      .get('/api/share/share-123/files/file-1')
      .set('If-None-Match', first.headers['etag']);

    expect(response.status).toBe(200);
    expect(response.headers['etag']).not.toBe(first.headers['etag']);
  });

  it('changes the validator when a same-size replacement moves the stored object', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['file-bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    const snapshot = {
      file_id: 'file-1',
      source: 'local',
      filepath: '/images/owner/plot.png?v=1',
      type: 'image/png',
      filename: 'plot.png',
      bytes: 1234,
    };
    getSharedLinkFile.mockResolvedValue({ file: snapshot, hasSnapshots: true });

    const app = buildApp();
    const first = await request(app).get('/api/share/share-123/files/file-1');

    // Re-published output: same file_id, same size, no revision, new stored path.
    getSharedLinkFile.mockResolvedValue({
      file: { ...snapshot, filepath: '/images/owner/plot.png?v=2' },
      hasSnapshots: true,
    });

    const response = await request(app)
      .get('/api/share/share-123/files/file-1')
      .set('If-None-Match', first.headers['etag']);

    expect(response.status).toBe(200);
    expect(response.headers['etag']).not.toBe(first.headers['etag']);
  });

  it('reapplies the share tenant file policy for a cross-tenant viewer', async () => {
    const liveFile = {
      file_id: 'file-1',
      status: 'ready',
      filename: 'report.pdf',
      text: 'safe extracted text',
    };
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/file-1',
        type: 'application/pdf',
        filename: 'report.pdf',
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([liveFile]);
    mockShareTenantId = 'tenant-owner';
    mockSharedLinkConfigMiddleware.mockImplementationOnce((req, _res, next) => {
      expect(req.user.tenantId).toBe('tenant-viewer');
      expect(req.shareTenantId).toBe('tenant-owner');
      req.config = { filters: contentFilters };
      next();
    });

    const response = await request(
      buildApp({ user: { id: 'viewer', role: 'USER', tenantId: 'tenant-viewer' } }),
    ).get('/api/share/share-123/files/file-1/download');

    expect(response.status).toBe(200);
    expect(mockAssertModelBoundContent).toHaveBeenCalledWith({
      filters: contentFilters,
      files: [liveFile],
    });
  });

  it('returns a raw-free 400 before serving a file that fails the current policy', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'content',
      },
    });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/file-1',
        type: 'application/pdf',
        filename: 'PRIVATE-SENTINEL.pdf',
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([
      { file_id: 'file-1', status: 'ready', filename: 'PRIVATE-SENTINEL.pdf' },
    ]);
    mockAssertModelBoundContent.mockImplementationOnce(() => {
      throw error;
    });

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123/files/file-1/download',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('forces attachment for unsafe inline types (no stored XSS)', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['<svg/>']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/evil.svg',
        type: 'image/svg+xml',
        filename: 'evil.svg',
      },
      hasSnapshots: true,
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/octet-stream');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('downloads a snapshotted file as an attachment', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/file-1',
        type: 'application/pdf',
        filename: 'report.pdf',
      },
      hasSnapshots: true,
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1/download');

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');
  });

  it('downloads stored text for a snapshotted text-source file', async () => {
    getFiles.mockResolvedValue([{ status: 'ready', text: 'Shared extracted text' }]);
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'text',
        filepath: 'mistral_ocr',
        type: 'application/pdf',
        filename: 'report.pdf',
      },
      hasSnapshots: true,
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1/download');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['content-disposition']).toContain('attachment; report.pdf.txt');
    expect(response.text).toBe('Shared extracted text');
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('returns 500 when the backing stream fails before sending bytes', async () => {
    const failingStream = new Readable({
      read() {
        this.destroy(new Error('storage unavailable'));
      },
    });
    mockGetStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn(async () => failingStream),
    });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/file-1',
        type: 'application/pdf',
        filename: 'report.pdf',
      },
      hasSnapshots: true,
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(500);
  });

  it('returns preview status read live from the file record', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: { file_id: 'file-1', source: 'local' },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([{ status: 'ready', text: 'extracted text', textFormat: 'text' }]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1/preview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      file_id: 'file-1',
      status: 'ready',
      text: 'extracted text',
      textFormat: 'text',
    });
    expect(getFiles).toHaveBeenCalledWith({ file_id: 'file-1' }, null, {});
  });

  it('404s for a file not in the snapshot without rebuilding it', async () => {
    getSharedLinkFile.mockResolvedValue({ file: null, hasSnapshots: true });

    const response = await request(buildApp()).get('/api/share/share-123/files/not-shared');

    expect(response.status).toBe(404);
    expect(backfillSharedLinkFiles).not.toHaveBeenCalled();
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('lazily backfills only a legacy share that has no snapshot field', async () => {
    getSharedLinkFile.mockResolvedValue({ file: null, hasSnapshots: false });
    backfillSharedLinkFiles.mockResolvedValue({
      file_id: 'file-1',
      source: 'local',
      filepath: '/images/owner/pic.png',
      type: 'image/png',
      filename: 'pic.png',
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(backfillSharedLinkFiles).toHaveBeenCalledWith('share-123', 'file-1');
  });

  it('404s cleanly when the snapshotted file is no longer available', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: { file_id: 'file-1', source: 'local', filepath: '/uploads/owner/gone.pdf' },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([]); // original record deleted/expired

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s (no serving) when the global kill switch is active', async () => {
    isFileSnapshotKillSwitchActive.mockReturnValueOnce(true);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(getSharedLinkFile).not.toHaveBeenCalled();
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s (no serving, no backfill) for a link that opted out of file sharing', async () => {
    getSharedLinkFile.mockResolvedValue({ file: null, hasSnapshots: false, optedOut: true });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(backfillSharedLinkFiles).not.toHaveBeenCalled();
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s when the snapshotted file version was overwritten (revision mismatch)', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/x',
        previewRevision: 'r1',
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([{ status: 'ready', previewRevision: 'r2' }]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s when the snapshotted file was overwritten (size/bytes mismatch)', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: { file_id: 'file-1', source: 'local', filepath: '/uploads/owner/x', bytes: 100 },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([{ status: 'ready', bytes: 200 }]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s when a same-size file reuse has a different source generation', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/x',
        bytes: 100,
        previewRevision: null,
        sourceDispatchedAt: 1000,
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([
      {
        status: 'ready',
        bytes: 100,
        previewRevision: null,
        metadata: { sourceDispatchedAt: 2000 },
      },
    ]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('uses legacy snapshot markers when only the live file has a source generation', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/x',
        bytes: 100,
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([
      {
        status: 'ready',
        bytes: 100,
        metadata: { sourceDispatchedAt: 2000 },
      },
    ]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(getDownloadStream).toHaveBeenCalled();
  });

  it('strips a cache-busting query string before local streaming', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/images/owner/pic.png?v=2',
        type: 'image/png',
        filename: 'pic.png',
        bytes: 100,
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([{ status: 'ready', bytes: 100 }]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), '/images/owner/pic.png');
  });

  it('sweeps an orphaned pending preview to failed', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: { file_id: 'file-1', source: 'local' },
      hasSnapshots: true,
    });
    const stale = new Date(Date.now() - 5 * 60 * 1000);
    getFiles.mockResolvedValue([{ status: 'pending', updatedAt: stale }]);
    updateFile.mockResolvedValue({ status: 'failed', previewError: 'orphaned' });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1/preview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      file_id: 'file-1',
      status: 'failed',
      previewError: 'orphaned',
    });
    expect(updateFile).toHaveBeenCalledWith(
      { file_id: 'file-1', status: 'failed', previewError: 'orphaned' },
      { status: 'pending', updatedAt: stale },
    );
  });
});
