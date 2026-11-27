const express = require('express');
const request = require('supertest');

const resolvedConfig = {
  projects: {
    maxFiles: 3,
    maxInstructionsLength: 120,
    maxDescriptionLength: 80,
  },
};
const mockHandler = jest.fn((req, res) => {
  res.status(200).json({ config: req.config });
});
const mockCreateProjectHandlers = jest.fn(() => ({
  listProjects: mockHandler,
  createProject: mockHandler,
  assignConversationToProject: mockHandler,
  getProject: mockHandler,
  updateProject: mockHandler,
  deleteProject: mockHandler,
  listProjectFiles: mockHandler,
  listAvailableProjectFiles: mockHandler,
  addProjectFile: mockHandler,
  removeProjectFile: mockHandler,
}));
const mockRequireJwtAuth = jest.fn((req, _res, next) => {
  req.user = { id: 'project-user', tenantId: 'tenant-a', role: 'USER' };
  next();
});
const mockConfigMiddleware = jest.fn((req, _res, next) => {
  req.config = resolvedConfig;
  next();
});

const mockGetRoleByName = jest.fn(async () => ({ name: 'USER', permissions: {} }));

jest.mock('@librechat/api', () => ({
  createProjectHandlers: mockCreateProjectHandlers,
  requireProjectsPermission: jest.requireActual('@librechat/api').requireProjectsPermission,
}));
jest.mock('~/models', () => ({
  getRoleByName: (...args) => mockGetRoleByName(...args),
  listChatProjects: jest.fn(),
  createChatProject: jest.fn(),
  getChatProject: jest.fn(),
  updateChatProject: jest.fn(),
  deleteChatProject: jest.fn(),
  assignConversationToProject: jest.fn(),
  addChatProjectFile: jest.fn(),
  removeChatProjectFile: jest.fn(),
  getProjectFiles: jest.fn(),
  getAvailableProjectFiles: jest.fn(),
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: mockRequireJwtAuth,
  configMiddleware: mockConfigMiddleware,
}));

const projectsRouter = require('../projects');

const app = express();
app.use(express.json());
app.use('/api/projects', projectsRouter);

const routeCases = [
  { name: 'list projects', method: 'get', path: '/api/projects', resolvesConfig: false },
  { name: 'create projects', method: 'post', path: '/api/projects', resolvesConfig: true },
  {
    name: 'assign conversations',
    method: 'put',
    path: '/api/projects/conversations/conversation-id',
    resolvesConfig: false,
  },
  {
    name: 'list available project files',
    method: 'get',
    path: '/api/projects/project-id/files/available',
    resolvesConfig: false,
  },
  {
    name: 'list project files',
    method: 'get',
    path: '/api/projects/project-id/files',
    resolvesConfig: false,
  },
  {
    name: 'add project files',
    method: 'post',
    path: '/api/projects/project-id/files',
    resolvesConfig: true,
  },
  {
    name: 'remove project files',
    method: 'delete',
    path: '/api/projects/project-id/files/file-id',
    resolvesConfig: false,
  },
  {
    name: 'get projects',
    method: 'get',
    path: '/api/projects/project-id',
    resolvesConfig: false,
  },
  {
    name: 'update projects',
    method: 'patch',
    path: '/api/projects/project-id',
    resolvesConfig: true,
  },
  {
    name: 'delete projects',
    method: 'delete',
    path: '/api/projects/project-id',
    resolvesConfig: false,
  },
];

describe('Projects route middleware', () => {
  beforeEach(() => {
    mockGetRoleByName.mockClear();
    mockRequireJwtAuth.mockClear();
    mockConfigMiddleware.mockClear();
    mockHandler.mockClear();
  });

  it.each(routeCases)(
    '$name resolves config only when required',
    async ({ method, path, resolvesConfig }) => {
      const response = await request(app)[method](path);

      expect(response.status).toBe(200);
      expect(mockRequireJwtAuth).toHaveBeenCalledTimes(1);
      expect(mockHandler).toHaveBeenCalledTimes(1);
      expect(mockHandler.mock.calls[0][0].config).toEqual(
        resolvesConfig ? resolvedConfig : undefined,
      );

      if (resolvesConfig) {
        expect(mockConfigMiddleware).toHaveBeenCalledTimes(1);
        expect(mockConfigMiddleware.mock.calls[0][0].user).toEqual({
          id: 'project-user',
          tenantId: 'tenant-a',
          role: 'USER',
        });
        expect(mockRequireJwtAuth.mock.invocationCallOrder[0]).toBeLessThan(
          mockConfigMiddleware.mock.invocationCallOrder[0],
        );
        expect(mockConfigMiddleware.mock.invocationCallOrder[0]).toBeLessThan(
          mockHandler.mock.invocationCallOrder[0],
        );
      } else {
        expect(mockConfigMiddleware).not.toHaveBeenCalled();
        expect(mockRequireJwtAuth.mock.invocationCallOrder[0]).toBeLessThan(
          mockHandler.mock.invocationCallOrder[0],
        );
      }
    },
  );
});

describe('Projects route permissions', () => {
  const projectsRole = (permissions) => ({ name: 'USER', permissions: { PROJECTS: permissions } });

  beforeEach(() => {
    mockHandler.mockClear();
    mockGetRoleByName.mockReset();
  });

  it.each(routeCases)('$name answers 403 without PROJECTS.USE', async ({ method, path }) => {
    mockGetRoleByName.mockResolvedValue(projectsRole({ USE: false, CREATE: true }));

    const response = await request(app)[method](path);

    expect(response.status).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
    expect(mockGetRoleByName).toHaveBeenCalledWith('USER');
  });

  it.each(routeCases)('$name without PROJECTS.CREATE', async ({ method, path, name }) => {
    mockGetRoleByName.mockResolvedValue(projectsRole({ USE: true, CREATE: false }));

    const response = await request(app)[method](path);

    const isCreate = name === 'create projects';
    expect(response.status).toBe(isCreate ? 403 : 200);
    expect(mockHandler).toHaveBeenCalledTimes(isCreate ? 0 : 1);
  });

  it('keeps projects for a role stored before the PROJECTS permission existed', async () => {
    mockGetRoleByName.mockResolvedValue({
      name: 'USER',
      permissions: { BOOKMARKS: { USE: true } },
    });

    const response = await request(app).post('/api/projects');

    expect(response.status).toBe(200);
    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  it('answers 500 without reaching the handler when the role read fails', async () => {
    mockGetRoleByName.mockRejectedValue(new Error('mongo down'));

    const response = await request(app).get('/api/projects');

    expect(response.status).toBe(500);
    expect(response.body.message).not.toContain('mongo');
    expect(mockHandler).not.toHaveBeenCalled();
  });
});
