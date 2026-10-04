const express = require('express');
const request = require('supertest');
const { PermissionBits } = require('librechat-data-provider');

const mockEncryptMetadata = jest.fn();
const mockDecryptMetadata = jest.fn();
const mockDomainParser = jest.fn();
const mockGetResourcePermissionsMap = jest.fn().mockResolvedValue(new Map());

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  generateCheckAccess: jest.fn(() => (_req, _res, next) => next()),
  isActionDomainAllowed: jest.fn().mockResolvedValue(true),
}));
jest.mock('~/server/services/ActionService', () => ({
  decryptMetadata: mockDecryptMetadata,
  encryptMetadata: mockEncryptMetadata,
  domainParser: mockDomainParser,
}));
jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn(),
  getResourcePermissionsMap: mockGetResourcePermissionsMap,
  grantPermission: jest.fn(),
}));
jest.mock('~/server/services/Agents/ownerContact', () => ({
  attachOwnerContacts: jest.fn(async (agents) => agents),
}));
jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
  getUserPrincipals: jest.fn().mockResolvedValue([]),
  hasCapabilityForPrincipals: jest.fn().mockResolvedValue(false),
  deleteTokens: jest.fn(),
  getListAgentsByAccess: jest.fn(),
  getActions: jest.fn(),
  getAgent: jest.fn(),
  // `instructionsPromptAccess` (below) reads this to tell an inaccessible-but-
  // existing link (redact) apart from one whose group has been deleted (show
  // as-is). The tests here exercise permission-only redaction, so the group
  // always exists.
  getPromptGroup: jest.fn().mockResolvedValue({
    _id: '507f1f77bcf86cd799439011',
    name: 'Fixture Group',
    author: 'owner-id',
    authorName: 'Owner',
  }),
  updateAgent: jest.fn(),
  updateAction: jest.fn(),
  deleteAction: jest.fn(),
}));
jest.mock('~/server/middleware', () => ({
  canAccessAgentResource: jest.fn(() => (_req, _res, next) => next()),
}));

const router = require('./actions');
const db = require('~/models');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.config = { filters: {} };
    req.user = { id: 'user-id', role: 'USER' };
    next();
  });
  app.use(router);
  return app;
}

const groupId = '507f1f77bcf86cd799439011';

const linkedInstructionsPrompt = {
  source: 'native',
  groupId,
  selection: { type: 'production' },
};

describe('POST /actions/:agent_id instructionsPrompt presentation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEncryptMetadata.mockImplementation(async (metadata) => metadata);
    mockDecryptMetadata.mockImplementation(async (metadata) => metadata);
    mockDomainParser.mockResolvedValue('encoded');
    mockGetResourcePermissionsMap.mockResolvedValue(new Map());
    db.getAgent.mockResolvedValue({
      id: 'agent-id',
      actions: [],
      tools: [],
      author: 'owner-id',
    });
    db.updateAction.mockResolvedValue({ metadata: { domain: 'example.test' } });
  });

  const postAction = (app) =>
    request(app)
      .post('/agent-id')
      .send({
        functions: [
          {
            type: 'function',
            function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } },
          },
        ],
        metadata: { domain: 'example.test' },
      });

  it('redacts an updatedAgent.instructionsPrompt link the caller cannot VIEW', async () => {
    db.updateAgent.mockResolvedValue({
      id: 'agent-id',
      instructionsPrompt: linkedInstructionsPrompt,
    });

    const response = await postAction(createApp());

    expect(response.status).toBe(200);
    expect(response.body[0].instructionsPrompt).toEqual({ source: 'native', restricted: true });
  });

  it('keeps a visible updatedAgent.instructionsPrompt link intact', async () => {
    mockGetResourcePermissionsMap.mockResolvedValue(new Map([[groupId, PermissionBits.VIEW]]));
    db.updateAgent.mockResolvedValue({
      id: 'agent-id',
      instructionsPrompt: linkedInstructionsPrompt,
    });

    const response = await postAction(createApp());

    expect(response.status).toBe(200);
    expect(response.body[0].instructionsPrompt).toEqual(linkedInstructionsPrompt);
  });

  it('redacts an inaccessible link inside updatedAgent.versions[] as well', async () => {
    db.updateAgent.mockResolvedValue({
      id: 'agent-id',
      versions: [{ name: 'v1', instructionsPrompt: linkedInstructionsPrompt }],
    });

    const response = await postAction(createApp());

    expect(response.status).toBe(200);
    expect(response.body[0].versions).toEqual([
      {
        name: 'v1',
        instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: false },
      },
    ]);
  });

  it('leaves the response unchanged when the updated agent carries no link', async () => {
    db.updateAgent.mockResolvedValue({ id: 'agent-id' });

    const response = await postAction(createApp());

    expect(response.status).toBe(200);
    expect(response.body[0]).not.toHaveProperty('instructionsPrompt');
    expect(mockGetResourcePermissionsMap).not.toHaveBeenCalled();
  });
});
