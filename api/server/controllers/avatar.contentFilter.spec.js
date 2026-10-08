jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  inspectContent: jest.fn(),
  extractFileContent: jest.fn((input) => [input]),
  contentFilterBlockResponse: jest.fn((finding) => ({
    error: 'content_filter_block',
    source: finding.source,
    field: finding.field,
  })),
  getBlockedUninspectableFileField: jest.fn(),
  contentFilterUninspectableResponse: jest.fn((field) => ({
    error: 'content_filter_uninspectable',
    source: 'file',
    field,
  })),
}));
jest.mock('~/models', () => ({
  getAgent: jest.fn(),
  updateAgent: jest.fn(),
  deleteFileByFilter: jest.fn(),
  updateAssistantDoc: jest.fn(),
  getAssistants: jest.fn(),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));
jest.mock('~/server/services/Files/images/avatar', () => ({
  resizeAvatar: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  filterFile: jest.fn(),
  uploadImageBuffer: jest.fn(),
}));
jest.mock('~/server/services/PermissionService', () => ({
  findPubliclyAccessibleResources: jest.fn(),
  getResourcePermissionsMap: jest.fn(),
  findAccessibleResources: jest.fn(),
  hasPublicPermission: jest.fn(),
  grantPermission: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn(),
}));
jest.mock('~/server/services/MCP', () => ({
  createMCPPermissionContext: jest.fn(),
  resolveConfigServers: jest.fn(),
  userCanUseMCPServers: jest.fn(),
}));
jest.mock('~/server/services/Agents/ownerContact', () => ({
  attachOwnerContacts: jest.fn(),
}));
jest.mock('~/config', () => ({
  getMCPServersRegistry: jest.fn(),
}));
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(),
}));
jest.mock('~/server/middleware/assistants/validateAuthor', () => jest.fn());
jest.mock('~/server/services/ActionService', () => ({
  deleteAssistantActions: jest.fn(),
}));
jest.mock('./assistants/helpers', () => ({
  getOpenAIClient: jest.fn(),
  fetchAssistants: jest.fn(),
}));

const fs = require('fs').promises;
const {
  inspectContent,
  extractFileContent,
  contentFilterBlockResponse,
  contentFilterUninspectableResponse,
  getBlockedUninspectableFileField,
} = require('@librechat/api');
const db = require('~/models');
const { filterFile, uploadImageBuffer } = require('~/server/services/Files/process');
const { getOpenAIClient } = require('./assistants/helpers');
const { uploadAgentAvatar } = require('./agents/v1');
const { uploadAssistantAvatar } = require('./assistants/v1');

describe('entity avatar filename content filtering', () => {
  let readFileSpy;
  let unlinkSpy;

  const filters = { files: { pii: { fields: ['name'] } } };
  const opaqueContentFilters = {
    files: {
      pii: {
        fields: ['content'],
        uninspectable: 'block',
      },
    },
  };
  const finding = {
    label: 'protected value',
    source: 'file',
    field: 'name',
  };

  const createRequest = (params, requestFilters = filters) => ({
    config: { filters: requestFilters },
    file: {
      path: '/tmp/avatar.png',
      originalname: 'avatar.png',
      mimetype: 'image/png',
      size: 10,
    },
    user: { id: 'user-1', tenantId: 'tenant-1' },
    params,
    body: {},
  });

  const createResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    readFileSpy = jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('image'));
    unlinkSpy = jest.spyOn(fs, 'unlink').mockResolvedValue();
    inspectContent.mockReturnValue(finding);
    getBlockedUninspectableFileField.mockReturnValue(null);
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it('invalidates the tenant-scoped list avatar cache after an accepted upload', async () => {
    const { getLogStores } = require('~/cache');
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const { resizeAvatar } = require('~/server/services/Files/images/avatar');
    const avatarCache = { delete: jest.fn().mockResolvedValue(undefined) };
    getLogStores.mockReturnValue(avatarCache);
    getStrategyFunctions.mockReturnValue({
      processAvatar: jest.fn().mockResolvedValue('new-avatar.jpg'),
    });
    resizeAvatar.mockResolvedValue(Buffer.from('resized'));
    db.getAgent.mockResolvedValue({ id: 'agent-1', avatar: null });
    db.updateAgent.mockResolvedValue({ id: 'agent-1', avatar: { filepath: 'new-avatar.jpg' } });
    inspectContent.mockReturnValue(null);

    const req = createRequest({ agent_id: 'agent-1' });
    req.config.fileStrategy = 's3';
    const res = createResponse();
    await uploadAgentAvatar(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(db.updateAgent).toHaveBeenCalled();
    expect(avatarCache.delete).toHaveBeenCalledWith('user-1:tenant-1:agents_avatar_refresh');
  });

  it('blocks an agent avatar filename before database or storage work', async () => {
    const req = createRequest({ agent_id: 'agent-1' });
    const res = createResponse();

    await uploadAgentAvatar(req, res);

    expect(filterFile).toHaveBeenCalledWith({
      req,
      file: req.file,
      image: true,
      isAvatar: true,
    });
    expect(extractFileContent).toHaveBeenCalledWith({ name: 'avatar.png' });
    expect(inspectContent).toHaveBeenCalledWith([{ name: 'avatar.png' }], { filters });
    expect(contentFilterBlockResponse).toHaveBeenCalledWith(finding);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.getAgent).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/avatar.png');
  });

  it('blocks uninspectable agent avatar content before database or storage work', async () => {
    inspectContent.mockReturnValueOnce(null);
    getBlockedUninspectableFileField.mockReturnValueOnce('content');
    const req = createRequest({ agent_id: 'agent-1' }, opaqueContentFilters);
    const res = createResponse();

    await uploadAgentAvatar(req, res);

    expect(getBlockedUninspectableFileField).toHaveBeenCalledWith(opaqueContentFilters, [
      'content',
    ]);
    expect(contentFilterUninspectableResponse).toHaveBeenCalledWith('content');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.getAgent).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/avatar.png');
  });

  it('blocks an assistant avatar filename before provider or storage work', async () => {
    const req = createRequest({ assistant_id: 'assistant-1' });
    const res = createResponse();

    await uploadAssistantAvatar(req, res);

    expect(filterFile).toHaveBeenCalledWith({
      req,
      file: req.file,
      image: true,
      isAvatar: true,
    });
    expect(extractFileContent).toHaveBeenCalledWith({ name: 'avatar.png' });
    expect(inspectContent).toHaveBeenCalledWith([{ name: 'avatar.png' }], { filters });
    expect(contentFilterBlockResponse).toHaveBeenCalledWith(finding);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getOpenAIClient).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(uploadImageBuffer).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/avatar.png');
  });

  it('blocks uninspectable assistant avatar content before provider or storage work', async () => {
    inspectContent.mockReturnValueOnce(null);
    getBlockedUninspectableFileField.mockReturnValueOnce('content');
    const req = createRequest({ assistant_id: 'assistant-1' }, opaqueContentFilters);
    const res = createResponse();

    await uploadAssistantAvatar(req, res);

    expect(getBlockedUninspectableFileField).toHaveBeenCalledWith(opaqueContentFilters, [
      'content',
    ]);
    expect(contentFilterUninspectableResponse).toHaveBeenCalledWith('content');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getOpenAIClient).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(uploadImageBuffer).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/avatar.png');
  });
});
