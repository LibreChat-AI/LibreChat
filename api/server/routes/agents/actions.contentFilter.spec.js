const express = require('express');
const request = require('supertest');

const mockEncryptMetadata = jest.fn();
const mockDecryptMetadata = jest.fn();
const mockDomainParser = jest.fn();

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
}));
jest.mock('~/server/services/Agents/ownerContact', () => ({
  attachOwnerContacts: jest.fn(),
}));
jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
  deleteTokens: jest.fn(),
  getListAgentsByAccess: jest.fn(),
  getActions: jest.fn(),
  getAgent: jest.fn(),
  updateAgent: jest.fn(),
  updateAction: jest.fn(),
  deleteAction: jest.fn(),
}));
jest.mock('~/server/middleware', () => ({
  canAccessAgentResource: jest.fn(() => (_req, _res, next) => next()),
}));

const router = require('./actions');
const db = require('~/models');
const { findAccessibleResources } = require('~/server/services/PermissionService');
const { CONTENT_TRAVERSAL_MAX_DEPTH } = require('@librechat/api');

function createApp(filters) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.config = { filters };
    req.user = { id: 'user-id', role: 'USER' };
    next();
  });
  app.use(router);
  return app;
}

function createOverflowingValue(visible) {
  const root = { visible };
  let current = root;
  for (let depth = 0; depth < CONTENT_TRAVERSAL_MAX_DEPTH; depth++) {
    current.nested = {};
    current = current.nested;
  }
  current.nested = { hidden: 'BLOCK-HIDDEN' };
  return root;
}

describe('agent action content filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEncryptMetadata.mockImplementation(async (metadata) => metadata);
    mockDecryptMetadata.mockImplementation(async (metadata) => metadata);
    mockDomainParser.mockResolvedValue('encoded');
    db.getAgent.mockResolvedValue({
      id: 'agent-id',
      actions: [],
      tools: [],
      author: 'owner-id',
    });
    db.getActions.mockResolvedValue([]);
    db.getListAgentsByAccess.mockResolvedValue({ data: [{ id: 'agent-id' }] });
    findAccessibleResources.mockResolvedValue(['agent-object-id']);
    db.updateAgent.mockResolvedValue({ id: 'agent-id' });
    db.updateAction.mockResolvedValue({ metadata: { domain: 'example.test' } });
  });

  it('blocks stored action metadata that violates the current read policy', async () => {
    const app = createApp({
      actionMetadata: {
        pii: {
          fields: ['privacy_policy_url'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'stored-metadata',
              label: 'stored metadata',
              regex: 'BLOCK-STORED',
            },
          ],
        },
      },
    });
    db.getActions.mockResolvedValue([
      {
        action_id: 'action-1',
        agent_id: 'agent-id',
        metadata: {
          domain: 'example.test',
          privacy_policy_url: 'https://example.test/BLOCK-STORED',
        },
      },
    ]);

    const response = await request(app).get('/');

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'action_metadata',
        field: 'privacy_policy_url',
      }),
    );
  });

  it('blocks a stored action specification that violates the current tool-argument policy', async () => {
    const app = createApp({
      toolArguments: {
        pii: {
          fields: ['arguments'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'stored-spec',
              label: 'stored spec',
              regex: 'BLOCK-SPEC',
            },
          ],
        },
      },
    });
    db.getActions.mockResolvedValue([
      {
        action_id: 'action-1',
        agent_id: 'agent-id',
        metadata: {
          domain: 'example.test',
          raw_spec: 'openapi: 3.0.0\ninfo:\n  title: BLOCK-SPEC',
        },
      },
    ]);

    const response = await request(app).get('/');

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'tool_argument',
        field: 'arguments',
      }),
    );
  });

  it('blocks an inspected partial parameter fragment before reporting traversal exhaustion', async () => {
    const app = createApp({
      toolArguments: {
        pii: {
          fields: ['arguments'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'partial-content',
              label: 'partial content',
              regex: 'BLOCK-VISIBLE',
            },
          ],
        },
      },
    });

    const response = await request(app)
      .post('/agent-id')
      .send({
        functions: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup',
              parameters: createOverflowingValue('BLOCK-VISIBLE'),
            },
          },
        ],
        metadata: { domain: 'example.test' },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'tool_argument',
        field: 'arguments',
      }),
    );
    expect(mockEncryptMetadata).not.toHaveBeenCalled();
  });

  it('fails closed when a selected action parameter scope cannot be fully inspected', async () => {
    const app = createApp({
      toolArguments: {
        pii: {
          fields: ['arguments'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'protected-content',
              label: 'protected content',
              regex: 'BLOCK-NOT-PRESENT',
            },
          ],
        },
      },
    });

    const response = await request(app)
      .post('/agent-id')
      .send({
        functions: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup',
              parameters: createOverflowingValue('safe visible value'),
            },
          },
        ],
        metadata: { domain: 'example.test' },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'content_filter_uninspectable',
      message: 'Submitted content could not be completely inspected before processing.',
      source: 'tool_argument',
      field: 'arguments',
    });
    expect(mockEncryptMetadata).not.toHaveBeenCalled();
  });

  it('does not fail closed when only an unrelated action field is selected', async () => {
    const app = createApp({
      toolArguments: {
        pii: {
          fields: ['name'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'protected-name',
              label: 'protected name',
              regex: 'BLOCK-NOT-PRESENT',
            },
          ],
        },
      },
    });

    const response = await request(app)
      .post('/agent-id')
      .send({
        functions: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup',
              parameters: createOverflowingValue('safe visible value'),
            },
          },
        ],
        metadata: { domain: 'example.test' },
      });

    expect(response.status).toBe(200);
    expect(db.updateAgent).toHaveBeenCalledTimes(1);
    expect(db.updateAction).toHaveBeenCalledTimes(1);
  });

  it('fails closed when merged stored action metadata exhausts the final projection', async () => {
    const app = createApp({
      toolArguments: {
        pii: {
          fields: ['arguments'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'protected-spec',
              label: 'protected spec',
              regex: 'BLOCK-NOT-PRESENT',
            },
          ],
        },
      },
    });
    db.getActions.mockResolvedValue([
      {
        action_id: 'action-1',
        agent_id: 'agent-id',
        metadata: { domain: 'example.test' },
      },
    ]);
    mockDecryptMetadata.mockResolvedValueOnce({
      domain: 'example.test',
      raw_spec: createOverflowingValue('safe visible value'),
    });

    const response = await request(app)
      .post('/agent-id')
      .send({
        action_id: 'action-1',
        functions: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup',
              parameters: { type: 'object' },
            },
          },
        ],
        metadata: { domain: 'example.test' },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_uninspectable',
        source: 'tool_argument',
        field: 'arguments',
      }),
    );
    expect(mockEncryptMetadata).toHaveBeenCalledTimes(1);
    expect(db.updateAgent).not.toHaveBeenCalled();
  });

  it('blocks nested authorization metadata before encryption or persistence', async () => {
    const app = createApp({
      actionMetadata: {
        pii: {
          fields: ['authorization_url'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'submitted-content',
              label: 'submitted content',
              regex: 'BLOCK-[A-Z]+',
            },
          ],
        },
      },
    });

    const response = await request(app)
      .post('/agent-id')
      .send({
        functions: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup',
              parameters: { type: 'object' },
            },
          },
        ],
        metadata: {
          domain: 'example.test',
          auth: {
            authorization_url: 'https://auth.example.test/BLOCK-AUTH',
          },
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'action_metadata',
        field: 'authorization_url',
      }),
    );
    expect(mockEncryptMetadata).not.toHaveBeenCalled();
  });

  it('blocks a generated agent tool name that matches only after transformation', async () => {
    const app = createApp({
      toolArguments: {
        pii: {
          fields: ['name'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'generated-name',
              label: 'generated name',
              regex: 'lookup_action_encoded',
            },
          ],
        },
      },
    });

    const response = await request(app)
      .post('/agent-id')
      .send({
        functions: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup',
              parameters: { type: 'object' },
            },
          },
        ],
        metadata: {
          domain: 'example.test',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'tool_argument',
        field: 'name',
      }),
    );
    expect(db.updateAgent).not.toHaveBeenCalled();
    expect(db.updateAction).not.toHaveBeenCalled();
  });

  it('rechecks stored metadata merged by a partial action update', async () => {
    const app = createApp({
      actionMetadata: {
        pii: {
          fields: ['privacy_policy_url'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'stored-metadata',
              label: 'stored metadata',
              regex: 'BLOCK-STORED',
            },
          ],
        },
      },
    });
    db.getActions.mockResolvedValue([
      {
        action_id: 'action-1',
        agent_id: 'agent-id',
        metadata: {
          domain: 'example.test',
          privacy_policy_url: 'https://example.test/BLOCK-STORED',
        },
      },
    ]);

    const response = await request(app)
      .post('/agent-id')
      .send({
        action_id: 'action-1',
        functions: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup',
              parameters: { type: 'object' },
            },
          },
        ],
        metadata: {
          domain: 'example.test',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'action_metadata',
        field: 'privacy_policy_url',
      }),
    );
    expect(db.updateAgent).not.toHaveBeenCalled();
    expect(db.updateAction).not.toHaveBeenCalled();
  });
});
