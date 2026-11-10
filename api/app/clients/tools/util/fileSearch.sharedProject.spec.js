jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  selectFileCitationSources: jest.fn(),
  generateShortLivedToken: jest.fn(),
  executeFileSearchQuery: jest.fn(),
}));
jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn(({ files }) => Promise.resolve(files)),
}));
jest.mock('~/models', () => ({ getFiles: jest.fn().mockResolvedValue([]) }));

const { EToolResources } = require('librechat-data-provider');
const { primeFiles } = require('./fileSearch');

const projectFile = (file_id, user) => ({ file_id, filename: `${file_id}.txt`, user });
const toolResources = (files) => ({ [EToolResources.file_search]: { files } });

describe('primeFiles shared project search owner', () => {
  it("marks only the server-resolved project's owner files for owner-scoped search", async () => {
    const ownerFile = projectFile('owner-file', 'owner');
    const req = {
      user: { id: 'member' },
      chatProjectContext: { ownerId: 'owner' },
      chatProjectFiles: [ownerFile],
    };

    const { files } = await primeFiles({
      req,
      tool_resources: toolResources([ownerFile, projectFile('member-upload', 'member')]),
    });

    expect(files.find((file) => file.file_id === 'owner-file').searchOwnerId).toBe('owner');
    expect(files.find((file) => file.file_id === 'member-upload')).not.toHaveProperty(
      'searchOwnerId',
    );
  });

  it('ignores a file id that only appears in the tool resources', async () => {
    const req = {
      user: { id: 'member' },
      chatProjectContext: { ownerId: 'owner' },
      chatProjectFiles: [],
    };

    const { files } = await primeFiles({
      req,
      tool_resources: toolResources([projectFile('owner-file', 'owner')]),
    });

    expect(files[0]).not.toHaveProperty('searchOwnerId');
  });

  it('leaves the owner searching their own project as themselves', async () => {
    const ownerFile = projectFile('owner-file', 'owner');
    const req = {
      user: { id: 'owner' },
      chatProjectContext: { ownerId: 'owner' },
      chatProjectFiles: [ownerFile],
    };

    const { files } = await primeFiles({ req, tool_resources: toolResources([ownerFile]) });

    expect(files[0]).not.toHaveProperty('searchOwnerId');
  });
});
