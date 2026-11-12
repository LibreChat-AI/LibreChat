const express = require('express');
const request = require('supertest');
const { processModelSpecs } = require('@librechat/data-schemas');
const { EModelEndpoint, specsConfigSchema } = require('librechat-data-provider');
const {
  createSubagentThreadTurnGuard,
  generateAgentTriggerToken,
  generateShortLivedToken,
  isAgentTriggerRequest,
  resolveModelSpecForEndpoint,
} = require('@librechat/api');

const mockGetAgent = jest.fn(async ({ id }) => ({
  id,
  _id: id,
  provider: EModelEndpoint.openAI,
  model: 'test-model',
}));
const mockCheckPermission = jest.fn(async ({ resourceId }) => resourceId === 'agent_B');

jest.mock('~/models', () => ({ getAgentWithVersionCount: mockGetAgent }));
jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: mockCheckPermission,
}));
jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: async () => false,
}));
jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: async () => ({}),
  getMCPServerTools: jest.fn(),
}));
jest.mock('~/server/services/MCP', () => ({ getAccessibleMCPServers: jest.fn() }));
jest.mock('~/server/services/Endpoints/assistants', () => ({ buildOptions: jest.fn() }));
jest.mock('~/server/services/Endpoints/azureAssistants', () => ({ buildOptions: jest.fn() }));
jest.mock('~/server/services/Endpoints/agents', () =>
  jest.requireActual('~/server/services/Endpoints/agents/build'),
);

const buildEndpointOption = require('./buildEndpointOption');
const { canAccessAgentFromBody } = require('./accessResources/canAccessAgentFromBody');

const spec = (agentId, name = 'shared', preset = {}, options = {}) => ({
  name,
  label: name,
  preset: { endpoint: EModelEndpoint.agents, agent_id: agentId, ...preset },
  ...options,
});

function createApp(mode, list, storedName = 'shared', endpoints) {
  const modelSpecs = processModelSpecs(endpoints, specsConfigSchema.parse({ enforce: true, list }));
  const child = {
    user: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    agent_id: 'agent_B',
    ...(mode === 'stored' && { spec: storedName }),
    ...(mode === 'binding' && {
      agentEventBinding: { bindingId: 'binding-1', sourceKeyId: 'key-1', actorId: 'actor-1' },
      subagentThread: { parentConversationId: 'parent-1', parentAgentId: 'agent_parent' },
    }),
  };
  const getConvo = jest.fn(async (_user, id) =>
    id === 'parent-1'
      ? { user: 'user-1', tenantId: 'tenant-1', conversationId: id, agent_id: 'agent_parent' }
      : child,
  );
  const guard = createSubagentThreadTurnGuard({
    getConvo,
    getEventBinding: async () => ({
      conversationId: child.conversationId,
      agentId: child.agent_id,
      tenantId: child.tenantId,
      binding: child.agentEventBinding,
      lineage: child.subagentThread,
    }),
    store: { isThreadActiveForOwner: () => false },
  });
  const state = {};
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', role: 'USER', tenantId: 'tenant-1' };
    req.config = { modelSpecs };
    req._isAgentTrigger = isAgentTriggerRequest(req);
    req.baseUrl = '/api/agents/chat';
    state.req = req;
    next();
  });
  app.post(
    '/chat',
    canAccessAgentFromBody({ requiredPermission: 1 }),
    guard,
    buildEndpointOption,
    async (req, res) => {
      const option = req.body.endpointOption;
      const agent = await option.agent;
      res.json({ spec: option.spec, agentId: option.agent_id, loadedAgentId: agent?.id });
    },
  );
  const post = ({ signed = true, selected } = {}) => {
    const token = signed ? generateAgentTriggerToken('user-1') : generateShortLivedToken('user-1');
    return request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .set('x-lc-agent-trigger', '1')
      .set('x-lc-agent-event-binding', 'binding-1')
      .set('x-lc-agent-event-source-key', 'key-1')
      .send({
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent_B',
        ...(mode === 'fire'
          ? {
              newConversationId: 'conversation-1',
              agentTrigger: { version: 1, event: { source: { type: 'webhook' } } },
            }
          : { conversationId: 'conversation-1' }),
        ...(selected !== undefined && { spec: selected }),
        // Copying guard metadata into JSON must never establish trusted context.
        _isAgentTrigger: true,
        _agentEventBindingId: 'binding-1',
      });
  };
  return { modelSpecs, getConvo, state, post };
}

const cases = [
  {
    name: 'A first, B second with the same name',
    list: [spec('agent_A'), spec('agent_B')],
    canonicalAgent: 'agent_A',
  },
  {
    name: 'B first, A second with the same name',
    list: [spec('agent_B'), spec('agent_A')],
    canonicalAgent: 'agent_B',
  },
  {
    name: 'same-agent duplicate names with different presets',
    list: [
      spec('agent_B', 'shared', { temperature: 0.1 }),
      spec('agent_B', 'shared', { temperature: 0.9 }),
    ],
    canonicalAgent: 'agent_B',
  },
  {
    name: 'duplicate names across endpoints',
    list: [spec('agent_A', 'shared', { endpoint: EModelEndpoint.openAI }), spec('agent_B')],
    canonicalError: 'model-spec-mismatch',
  },
  {
    name: 'default and order flags cannot disambiguate names',
    list: [
      spec('agent_A', 'shared', {}, { default: true, order: 9 }),
      spec('agent_B', 'shared', {}, { order: 0 }),
    ],
    canonicalAgent: 'agent_A',
  },
  {
    name: 'an empty name cannot be restored',
    list: [spec('agent_B', '')],
    targetName: '',
    canonicalError: 'invalid-model-spec',
  },
  {
    name: 'agent IDs remain case-sensitive',
    list: [spec('agent_b')],
    canonicalAgent: 'agent_b',
  },
  {
    name: 'custom endpoint normalization cannot become the agents endpoint',
    list: [spec('agent_B', 'shared', { endpoint: 'OLLAMA' })],
    endpoints: { custom: [{ name: 'Ollama' }] },
    canonicalError: 'model-spec-mismatch',
    normalizedEndpoint: 'ollama',
  },
  {
    name: 'unrelated name collisions do not disable a unique target',
    list: [spec('agent_A', 'other'), spec('agent_C', 'other'), spec('agent_B')],
    canonicalAgent: 'agent_B',
    allowed: true,
  },
  {
    name: 'a unique healthy spec',
    list: [spec('agent_B')],
    canonicalAgent: 'agent_B',
    allowed: true,
  },
  {
    name: 'case-distinct names remain exact',
    list: [spec('agent_A', 'Shared'), spec('agent_B')],
    canonicalAgent: 'agent_B',
    allowed: true,
  },
  {
    name: 'whitespace-distinct names remain exact',
    list: [spec('agent_A', ' shared '), spec('agent_B')],
    canonicalAgent: 'agent_B',
    allowed: true,
  },
  {
    name: 'an omitted endpoint is materialized by the real loader',
    list: [spec('agent_B', 'shared', { endpoint: undefined })],
    canonicalAgent: 'agent_B',
    allowed: true,
  },
  {
    name: 'an explicit null endpoint is skipped by the real loader',
    list: [spec('agent_A', 'shared', { endpoint: null }), spec('agent_B')],
    canonicalAgent: 'agent_B',
    allowed: true,
  },
  {
    name: 'another named preset is ambiguous only for fallback',
    list: [spec('agent_B'), spec('agent_B', 'other')],
    canonicalAgent: 'agent_B',
    storedOnly: true,
  },
];

describe.each(['fire', 'binding', 'stored'])('enforced %s spec identity', (mode) => {
  beforeEach(() => jest.clearAllMocks());

  it.each(cases)(
    '$name',
    async ({
      list,
      canonicalAgent,
      canonicalError,
      allowed,
      storedOnly,
      targetName = 'shared',
      endpoints,
      normalizedEndpoint,
    }) => {
      const { modelSpecs, getConvo, state, post } = createApp(mode, list, targetName, endpoints);
      if (normalizedEndpoint) expect(modelSpecs.list[0].preset.endpoint).toBe(normalizedEndpoint);
      const canonical = resolveModelSpecForEndpoint({
        modelSpecs,
        spec: targetName,
        endpoint: EModelEndpoint.agents,
      });
      if (canonicalError) expect(canonical.error).toBe(canonicalError);
      else expect(canonical.modelSpec.preset.agent_id).toBe(canonicalAgent);

      const response = await post();
      expect(mockCheckPermission).toHaveBeenCalledTimes(1);
      expect(mockCheckPermission).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: 'agent_B' }),
      );
      expect(mockGetAgent).not.toHaveBeenCalledWith({ id: 'agent_A' });
      expect(getConvo).toHaveBeenCalledTimes({ fire: 0, binding: 2, stored: 1 }[mode]);

      if (allowed || (storedOnly && mode === 'stored')) {
        expect(response.body).toEqual({
          spec: 'shared',
          agentId: 'agent_B',
          loadedAgentId: 'agent_B',
        });
        expect(mockGetAgent).toHaveBeenCalledTimes(2); // Authorization read, then actual saved-agent load.
        expect(state.req.body.spec).toBe('shared');
        const restored = resolveModelSpecForEndpoint({
          modelSpecs,
          spec: state.req.body.spec,
          endpoint: EModelEndpoint.agents,
        });
        expect(restored.modelSpec.preset.agent_id).toBe('agent_B');
      } else {
        expect(response.text).toContain('No model spec selected');
        expect(state.req.body).not.toHaveProperty('spec');
        expect(mockGetAgent).toHaveBeenCalledTimes(1); // No agent initialization after authorization.
      }
    },
  );

  it.each([
    ['missing', 'Invalid model spec'],
    ['', 'No model spec selected'],
    [123, 'No model spec selected'],
  ])('does not repair explicit invalid spec %s', async (selected, error) => {
    const { state, post } = createApp(mode, [spec('agent_B')]);
    const response = await post({ selected });
    expect(response.text).toContain(error);
    expect(state.req.body.spec).toBe(selected);
    expect(mockGetAgent).toHaveBeenCalledTimes(1);
  });

  it('authorizes an explicit colliding name through the existing canonical resolver', async () => {
    const { state, post } = createApp(mode, [spec('agent_A'), spec('agent_B')]);
    const response = await post({ selected: 'shared' });
    expect(response.status).toBe(403);
    expect(state.req.body.spec).toBe('shared');
    expect(mockCheckPermission).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'agent_A' }),
    );
    expect(mockGetAgent).toHaveBeenCalledTimes(1); // Only the canonical agent's denied ACL lookup.
  });

  it('does not trust unsigned continuation metadata', async () => {
    const { post } = createApp(mode, [spec('agent_B')]);
    const response = await post({ signed: false });
    expect(response.text).toContain(mode === 'binding' ? 'view-only' : 'No model spec selected');
    expect(mockGetAgent).toHaveBeenCalledTimes(1);
  });
});

describe('stored continuation spec invalidation', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['removed', 'retargeted'])(
    'does not replace a %s stored spec with another agent preset',
    async (failure) => {
      const list = [spec('agent_B', 'replacement')];
      if (failure === 'retargeted') list.unshift(spec('agent_A'));
      const { state, post } = createApp('stored', list);
      const response = await post();
      expect(response.text).toContain('No model spec selected');
      expect(state.req.body).not.toHaveProperty('spec');
      expect(mockCheckPermission).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: 'agent_B' }),
      );
      expect(mockGetAgent).toHaveBeenCalledTimes(1);
      expect(mockGetAgent).not.toHaveBeenCalledWith({ id: 'agent_A' });
    },
  );
});
