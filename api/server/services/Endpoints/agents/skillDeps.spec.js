const mockSaveBuffer = jest.fn();
const mockDeleteFile = jest.fn();
const mockGetStrategyFunctions = jest.fn();
const mockGetFileStrategy = jest.fn();
const mockGetStorageMetadata = jest.fn();
const mockResolveRequestTenantId = jest.fn();
const mockCreateDeploymentSkillMethods = jest.fn((methods) => methods);
const mockSaveSkillFileContent = jest.fn();
const mockSaveSkillManagementFileContent = jest.fn();
let mockSaverDeps;
let mockManagementSaverDeps;
const mockCreateSkillFileSaver = jest.fn((deps) => {
  mockSaverDeps = deps;
  return mockSaveSkillFileContent;
});
const mockCreateSkillManagementFileSaver = jest.fn((deps) => {
  mockManagementSaverDeps = deps;
  return mockSaveSkillManagementFileContent;
});
const mockReadWorkspaceFile = jest.fn();
const mockSearchWorkspace = jest.fn();
const mockListWorkspaceFiles = jest.fn();
const mockWriteWorkspaceFile = jest.fn();
const mockPreviewWorkspaceEdit = jest.fn();
const mockEditWorkspaceFile = jest.fn();

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: (...args) => mockGetStrategyFunctions(...args),
}));

jest.mock('~/server/services/Files/Code/crud', () => ({
  batchUploadCodeEnvFiles: jest.fn(),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  getSessionInfo: jest.fn(),
  checkIfActive: jest.fn(),
  readSandboxFile: jest.fn(),
  readWorkspaceFile: (...args) => mockReadWorkspaceFile(...args),
  searchWorkspace: (...args) => mockSearchWorkspace(...args),
  listWorkspaceFiles: (...args) => mockListWorkspaceFiles(...args),
  writeWorkspaceFile: (...args) => mockWriteWorkspaceFile(...args),
  previewWorkspaceEdit: (...args) => mockPreviewWorkspaceEdit(...args),
  editWorkspaceFile: (...args) => mockEditWorkspaceFile(...args),
  writeSandboxFile: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  checkAccess: jest.fn(),
  createDeploymentSkillMethods: (...args) => mockCreateDeploymentSkillMethods(...args),
  createSkillFileSaver: (...args) => mockCreateSkillFileSaver(...args),
  createSkillManagementFileSaver: (...args) => mockCreateSkillManagementFileSaver(...args),
  enrichWithSkillConfigurable: jest.fn(),
  getDeploymentSkillDownloadStream: jest.fn(),
  getStorageMetadata: (...args) => mockGetStorageMetadata(...args),
  isDeploymentSkillFileSource: jest.fn(() => false),
  mergeDeploymentSkillIds: jest.fn((ids = []) => ids),
  resolveRequestTenantId: (...args) => mockResolveRequestTenantId(...args),
}));

jest.mock('librechat-data-provider', () => ({
  AccessRoleIds: { SKILL_OWNER: 'SKILL_OWNER' },
  FileContext: { skill_file: 'skill_file' },
  PermissionBits: { EDIT: 2 },
  Permissions: { USE: 'USE', CREATE: 'CREATE' },
  PermissionTypes: { SKILLS: 'SKILLS' },
  PrincipalType: { USER: 'USER' },
  ResourceType: { SKILL: 'SKILL' },
  isEphemeralAgentId: jest.fn(() => false),
}));

jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: jest.fn(),
  grantPermission: jest.fn(),
}));

jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: (...args) => mockGetFileStrategy(...args),
}));

const mockDb = {
  getSkillFileByPath: jest.fn(),
  upsertSkillFile: jest.fn(),
};

jest.mock('~/models', () => mockDb);

const { getSkillToolDeps, getSkillManagementFileSaver } = require('./skillDeps');

describe('skillDeps saveSkillFileContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFileStrategy.mockReturnValue('s3');
    mockGetStrategyFunctions.mockReturnValue({
      saveBuffer: mockSaveBuffer,
      deleteFile: mockDeleteFile,
    });
    mockSaveBuffer.mockResolvedValue('https://files.example.test/uploads/file.txt');
    mockDeleteFile.mockResolvedValue(undefined);
    mockGetStorageMetadata.mockReturnValue({
      storageKey: 'uploads/file.txt',
      storageRegion: 'us-east-2',
    });
    mockResolveRequestTenantId.mockReturnValue('tenant-1');
    mockDb.getSkillFileByPath.mockResolvedValue(null);
  });

  it('exposes the stable attached-workspace reader to agent handlers', () => {
    expect(getSkillToolDeps().readWorkspaceFile).toBeDefined();
    getSkillToolDeps().readWorkspaceFile({ file_path: 'src/app.ts' });
    expect(mockReadWorkspaceFile).toHaveBeenCalledWith({ file_path: 'src/app.ts' });
  });

  it('exposes the stable attached-workspace searcher to agent handlers', () => {
    expect(getSkillToolDeps().searchWorkspace).toBeDefined();
    getSkillToolDeps().searchWorkspace({ query: 'needle' });
    expect(mockSearchWorkspace).toHaveBeenCalledWith({ query: 'needle' });
  });

  it('exposes the stable attached-workspace file lister to agent handlers', () => {
    expect(getSkillToolDeps().listWorkspaceFiles).toBeDefined();
    getSkillToolDeps().listWorkspaceFiles({ path: 'src' });
    expect(mockListWorkspaceFiles).toHaveBeenCalledWith({ path: 'src' });
  });

  it('exposes attached-workspace mutations to agent handlers', () => {
    getSkillToolDeps().writeWorkspaceFile({ path: 'src/new.ts' });
    getSkillToolDeps().previewWorkspaceEdit({ path: 'src/app.ts' });
    getSkillToolDeps().editWorkspaceFile({ path: 'src/app.ts' });
    expect(mockWriteWorkspaceFile).toHaveBeenCalledWith({ path: 'src/new.ts' });
    expect(mockPreviewWorkspaceEdit).toHaveBeenCalledWith({ path: 'src/app.ts' });
    expect(mockEditWorkspaceFile).toHaveBeenCalledWith({ path: 'src/app.ts' });
  });

  it('wires the typed saver to the existing database and storage strategies', async () => {
    expect(mockSaverDeps.getSkillFileByPath).toBe(mockDb.getSkillFileByPath);
    expect(mockSaverDeps.upsertSkillFile).toBe(mockDb.upsertSkillFile);
    expect(mockSaverDeps.getStrategyFunctions).toBeDefined();
    expect(mockManagementSaverDeps).toBe(mockSaverDeps);
    const req = { user: { id: 'user-1' }, config: {} };
    const storage = mockSaverDeps.resolveStorage(req, { isImage: false });
    expect(storage).toEqual({ source: 's3', saveBuffer: mockSaveBuffer });
    expect(mockGetFileStrategy).toHaveBeenCalledWith(req.config, {
      context: 'skill_file',
      isImage: false,
    });

    const params = {
      req,
      skillId: 'skill-1',
      relativePath: 'references/template.html',
      content: '<html></html>',
      mimeType: 'text/html',
      expectedFileId: 'revision-1',
      createOnly: false,
    };
    mockSaveSkillFileContent.mockResolvedValue({ bytes: 13, relativePath: params.relativePath });
    await expect(getSkillToolDeps().saveSkillFileContent(params)).resolves.toEqual({
      bytes: 13,
      relativePath: params.relativePath,
    });
    expect(mockSaveSkillFileContent).toHaveBeenCalledWith(params);
  });

  it('uses an independent management saver for existing content-only PUT requests', async () => {
    const params = {
      req: { user: { id: 'user-1' } },
      skillId: 'skill-1',
      relativePath: 'references/template.html',
      content: '<html></html>',
      mimeType: 'text/plain',
    };
    mockSaveSkillManagementFileContent.mockResolvedValue({
      bytes: 13,
      relativePath: params.relativePath,
    });
    await expect(getSkillManagementFileSaver()(params)).resolves.toEqual({
      bytes: 13,
      relativePath: params.relativePath,
    });
    expect(mockSaveSkillManagementFileContent).toHaveBeenCalledWith(params);
    expect(mockSaveSkillFileContent).not.toHaveBeenCalled();
  });
});
