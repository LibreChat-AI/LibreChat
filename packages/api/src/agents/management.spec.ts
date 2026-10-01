import { z } from 'zod';
import { MAX_SUBAGENTS, setMaxSubagents } from 'librechat-data-provider';
import {
  agentManagementCreateSchema,
  agentManagementDeleteResponseSchema,
  agentManagementListResponseSchema,
  agentManagementListSchema,
  agentManagementResponseSchema,
  agentManagementUpdateSchema,
  mapAgentManagementError,
  projectAgentManagementListResponse,
  projectAgentManagementResponse,
} from './management';

const timestamps = {
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  updatedAt: new Date('2026-09-02T10:00:00.000Z'),
};

const persistedAgent = {
  _id: '64da00000000000000000001',
  id: 'agent_public_id',
  tenantId: 'tenant-secret',
  author: 'user-secret',
  credentials: { apiKey: 'secret' },
  versions: [{}, {}],
  mcpServerNames: ['private-routing-name'],
  is_promoted: true,
  name: 'Researcher',
  description: 'Finds primary sources',
  instructions: 'Be precise',
  provider: 'openAI',
  model: 'gpt-5',
  model_parameters: { temperature: 0.2 },
  tools: ['web_search'],
  skills: ['64da00000000000000000002'],
  conversation_starters: ['Research this'],
  ...timestamps,
};

describe('Agent Management contract', () => {
  it('preserves repository instruction mode through API updates and response projection', () => {
    for (const mode of ['prefer', 'defer', 'off'] as const) {
      expect(agentManagementUpdateSchema.parse({ repositoryInstructions: mode })).toEqual({
        repositoryInstructions: mode,
      });
      expect(
        projectAgentManagementResponse({ ...persistedAgent, repositoryInstructions: mode })
          .repositoryInstructions,
      ).toBe(mode);
    }
    expect(
      agentManagementUpdateSchema.safeParse({ repositoryInstructions: 'allow-all' }).success,
    ).toBe(false);
  });
  describe('inputs', () => {
    it('keeps create and update fields aligned with the browser Agent validators', () => {
      expect(
        agentManagementCreateSchema.parse({
          provider: 'openAI',
          model: 'gpt-5',
          name: 'Researcher',
          stateful_code_environment: 'agent-user',
          git_identity: { name: 'LibreChat Agent', email: 'agent@example.com' },
          subagents: { enabled: true, allowSelf: true, agent_ids: [] },
        }),
      ).toMatchObject({ provider: 'openAI', model: 'gpt-5', tools: [] });

      expect(
        agentManagementUpdateSchema.parse({
          instructions: 'Updated',
          model_parameters: { temperature: 0.1 },
          code_environment_id: null,
          git_identity: { name: 'LibreChat Agent', email: 'agent@example.com' },
        }),
      ).toEqual({
        instructions: 'Updated',
        model_parameters: { temperature: 0.1 },
        code_environment_id: null,
        git_identity: { name: 'LibreChat Agent', email: 'agent@example.com' },
      });
    });

    it.each([agentManagementCreateSchema, agentManagementUpdateSchema])(
      'rejects unknown and read-only fields',
      (schema) => {
        const base =
          schema === agentManagementCreateSchema ? { provider: 'openAI', model: 'gpt-5' } : {};
        expect(schema.safeParse({ ...base, _id: '64da00000000000000000001' }).success).toBe(false);
        expect(schema.safeParse({ ...base, id: 'agent_forged' }).success).toBe(false);
        expect(schema.safeParse({ ...base, tenantId: 'tenant_forged' }).success).toBe(false);
        expect(schema.safeParse({ ...base, credentials: { apiKey: 'secret' } }).success).toBe(
          false,
        );
        expect(schema.safeParse({ ...base, versions: [] }).success).toBe(false);
      },
    );

    it('rejects a null model before Agent creation reaches persistence', () => {
      expect(
        agentManagementCreateSchema.safeParse({ provider: 'openAI', model: null }).success,
      ).toBe(false);
    });

    it.each([
      { name: null },
      { description: null },
      { instructions: null },
      { model: null },
      { avatar: { filepath: 'avatars/replacement.png', source: 'local' } },
    ])('rejects update values the browser update flow cannot apply: %p', (update) => {
      expect(agentManagementUpdateSchema.safeParse(update).success).toBe(false);
    });

    it('accepts the explicitly supported update clears', () => {
      expect(
        agentManagementUpdateSchema.parse({ avatar: null, code_environment_id: null }),
      ).toEqual({ avatar: null, code_environment_id: null });
    });
  });

  describe('pagination', () => {
    const cursor = Buffer.from(
      JSON.stringify({
        updatedAt: '2026-09-02T10:00:00.000Z',
        _id: '64da00000000000000000001',
      }),
    ).toString('base64');

    it('normalizes a bounded limit and accepts the opaque database cursor', () => {
      expect(agentManagementListSchema.parse({ limit: '25', cursor })).toEqual({
        limit: 25,
        cursor,
      });
      expect(agentManagementListSchema.parse({})).toEqual({ limit: 20 });
    });

    it.each([
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { cursor: 'not-a-cursor' },
      {
        cursor: Buffer.from(JSON.stringify({ updatedAt: 'nope', _id: 'nope' })).toString('base64'),
      },
      { search: 'unsupported' },
    ])('rejects invalid list input %#', (input) => {
      expect(agentManagementListSchema.safeParse(input).success).toBe(false);
    });

    it('projects every list item and emits only a usable next cursor', () => {
      const response = projectAgentManagementListResponse({
        data: [persistedAgent],
        has_more: true,
        after: cursor,
      });

      expect(agentManagementListResponseSchema.parse(response)).toEqual(response);
      expect(response).toMatchObject({
        object: 'list',
        first_id: 'agent_public_id',
        last_id: 'agent_public_id',
        has_more: true,
        after: cursor,
      });
      expect(
        projectAgentManagementListResponse({ data: [], has_more: false, after: cursor }),
      ).toEqual({
        object: 'list',
        data: [],
        first_id: null,
        last_id: null,
        has_more: false,
        after: null,
      });

      expect(
        agentManagementListResponseSchema.safeParse({
          ...response,
          has_more: true,
          after: null,
        }).success,
      ).toBe(false);
    });
  });

  describe('responses', () => {
    it('validates the minimal deletion tombstone', () => {
      expect(
        agentManagementDeleteResponseSchema.parse({ id: 'agent_public_id', deleted: true }),
      ).toEqual({ id: 'agent_public_id', deleted: true });
      expect(
        agentManagementDeleteResponseSchema.safeParse({
          id: 'agent_public_id',
          deleted: true,
          tenantId: 'tenant-secret',
        }).success,
      ).toBe(false);
    });

    it('allowlists supported configuration and stable metadata', () => {
      const response = projectAgentManagementResponse(persistedAgent);

      expect(agentManagementResponseSchema.parse(response)).toEqual(response);
      expect(response).toMatchObject({
        id: 'agent_public_id',
        version: 2,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-02T10:00:00.000Z',
        name: 'Researcher',
        provider: 'openAI',
        model: 'gpt-5',
      });
      expect(response).not.toHaveProperty('_id');
      expect(response).not.toHaveProperty('tenantId');
      expect(response).not.toHaveProperty('author');
      expect(response).not.toHaveProperty('credentials');
      expect(response).not.toHaveProperty('versions');
      expect(response).not.toHaveProperty('mcpServerNames');
      expect(response).not.toHaveProperty('is_promoted');
    });

    it('omits legacy string avatars that are not part of the management contract', () => {
      const response = projectAgentManagementResponse({
        ...persistedAgent,
        avatar: 'https://example.com/legacy-avatar.png',
      });

      expect(JSON.parse(JSON.stringify(response))).not.toHaveProperty('avatar');
      expect(agentManagementResponseSchema.parse(response)).toEqual(response);
    });

    it('does not apply the current request admission limit to persisted subagents', () => {
      const subagents = {
        enabled: true,
        agent_ids: Array.from({ length: MAX_SUBAGENTS }, (_, index) => `agent_${index}`),
      };

      setMaxSubagents(1);
      try {
        expect(agentManagementUpdateSchema.safeParse({ subagents }).success).toBe(false);
        expect(projectAgentManagementResponse({ ...persistedAgent, subagents }).subagents).toEqual(
          subagents,
        );
      } finally {
        setMaxSubagents(undefined);
      }
    });
  });

  describe('errors', () => {
    it.each([
      ['not_found', 404, 'Agent not found'],
      ['permission_denied', 403, 'Permission denied'],
      ['internal_error', 500, 'Internal server error'],
    ] as const)('maps %s without leaking an internal error', (code, status, message) => {
      expect(mapAgentManagementError(code, new Error('database password leaked'))).toEqual({
        status,
        body: { error: { code, message } },
      });
    });

    it('maps validation issues to safe paths and messages', () => {
      const validation = z.object({ limit: z.number().max(100) }).safeParse({ limit: 101 });
      if (validation.success) {
        throw new Error('Expected validation to fail');
      }

      expect(mapAgentManagementError('invalid_request', validation.error)).toMatchObject({
        status: 400,
        body: {
          error: {
            code: 'invalid_request',
            message: 'Invalid request',
            details: [{ path: ['limit'] }],
          },
        },
      });
    });
  });
});
