import {
  EModelEndpoint,
  MAX_SUBAGENTS,
  setMaxSubagents,
  MAX_SUBAGENT_GRAPH_NODES,
  MAX_GRAPH_SUBAGENT_MEMBERS,
  Providers,
} from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import {
  agentCreateSchema,
  agentUpdateSchema,
  agentSubagentsSchema,
  validateAgentModel,
} from './validation';

describe('agent Git identity validation', () => {
  const base = { provider: 'openAI', model: 'gpt-4o-mini', tools: [] };

  it('accepts and trims a valid commit identity', () => {
    expect(
      agentCreateSchema.parse({
        ...base,
        git_identity: { name: '  Coding Agent  ', email: '  agent@example.com  ' },
      }).git_identity,
    ).toEqual({ name: 'Coding Agent', email: 'agent@example.com' });
  });

  it('accepts a GitHub App bot noreply address for commit attribution', () => {
    const git_identity = {
      name: 'Lia',
      email: '328778573+lia-by-librechat[bot]@users.noreply.github.com',
    };
    expect(agentCreateSchema.parse({ ...base, git_identity }).git_identity).toEqual(git_identity);
  });

  it.each([
    { name: '', email: 'agent@example.com' },
    { name: 'Coding Agent\nInjected', email: 'agent@example.com' },
    { name: 'Coding Agent', email: 'not-an-email' },
    { name: 'Coding Agent', email: 'lia-by-librechat[bot]@users.noreply.github.com' },
    { name: 'Coding Agent', email: '328778573+lia-by-librechat[bot]@example.com' },
  ])('rejects an unsafe or incomplete identity: %j', (git_identity) => {
    expect(agentCreateSchema.safeParse({ ...base, git_identity }).success).toBe(false);
  });

  it('accepts null only when updating to clear a configured identity', () => {
    expect(agentCreateSchema.safeParse({ ...base, git_identity: null }).success).toBe(false);
    expect(agentUpdateSchema.parse({ git_identity: null })).toEqual({ git_identity: null });
  });
});

describe('agentSubagentsSchema', () => {
  const graph = {
    type: 'research_team',
    name: 'Research team',
    description: 'Researches and writes a final answer',
    agent_ids: ['agent_researcher', 'agent_writer'],
    edges: [{ from: 'agent_researcher', to: 'agent_writer', edgeType: 'direct' as const }],
    entry_agent_id: 'agent_researcher',
    result_agent_id: 'agent_writer',
  };

  it('accepts enabled:true with a list within the cap', () => {
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      allowSelf: false,
      agent_ids: ['agent_1', 'agent_2'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts the feature-off shape (enabled:false, no agents)', () => {
    const result = agentSubagentsSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it('rejects agent_ids longer than MAX_SUBAGENTS', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => `agent_${i}`);
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      agent_ids: oversized,
    });
    expect(result.success).toBe(false);
  });

  it('accepts exactly MAX_SUBAGENTS entries', () => {
    const atCap = Array.from({ length: MAX_SUBAGENTS }, (_, i) => `agent_${i}`);
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      agent_ids: atCap,
    });
    expect(result.success).toBe(true);
  });

  it('accepts above the default cap when the configured limit is raised', () => {
    setMaxSubagents(MAX_SUBAGENTS + 10);
    const raised = Array.from({ length: MAX_SUBAGENTS + 5 }, (_, i) => `agent_${i}`);
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      agent_ids: raised,
    });
    setMaxSubagents(undefined);
    expect(result.success).toBe(true);
  });

  it('rejects above the raised cap and resets on invalid configured values', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 11 }, (_, i) => `agent_${i}`);

    setMaxSubagents(MAX_SUBAGENTS + 10);
    const overRaised = agentSubagentsSchema.safeParse({
      enabled: true,
      agent_ids: oversized,
    });

    setMaxSubagents(MAX_SUBAGENTS + 100);
    const afterInvalid = agentSubagentsSchema.safeParse({
      enabled: true,
      agent_ids: oversized,
    });

    setMaxSubagents(undefined);
    expect(overRaised.success).toBe(false);
    expect(afterInvalid.success).toBe(false);
  });

  it('accepts an explicit bounded graph subagent', () => {
    expect(
      agentSubagentsSchema.safeParse({ enabled: true, allowSelf: false, graphs: [graph] }).success,
    ).toBe(true);
  });

  it('accepts a one-member graph with no edges', () => {
    expect(
      agentSubagentsSchema.safeParse({
        enabled: true,
        allowSelf: false,
        graphs: [
          {
            ...graph,
            agent_ids: ['agent_solo'],
            edges: [],
            entry_agent_id: 'agent_solo',
            result_agent_id: 'agent_solo',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts excludeResults:false without an edge prompt', () => {
    expect(
      agentSubagentsSchema.safeParse({
        enabled: true,
        allowSelf: false,
        graphs: [
          {
            ...graph,
            edges: [{ ...graph.edges[0], excludeResults: false }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects configurations above the aggregate unique-agent cap', () => {
    const firstAgentIds = Array.from(
      { length: MAX_GRAPH_SUBAGENT_MEMBERS },
      (_, index) => `first_${index}`,
    );
    const secondAgentIds = Array.from(
      { length: MAX_SUBAGENT_GRAPH_NODES - MAX_GRAPH_SUBAGENT_MEMBERS + 1 },
      (_, index) => `second_${index}`,
    );
    const toChain = (agentIds: string[]) =>
      agentIds.slice(1).map((agentId, index) => ({
        from: agentIds[index],
        to: agentId,
        edgeType: 'direct' as const,
      }));

    expect(
      agentSubagentsSchema.safeParse({
        enabled: true,
        allowSelf: false,
        graphs: [
          {
            ...graph,
            type: 'first_team',
            agent_ids: firstAgentIds,
            edges: toChain(firstAgentIds),
            entry_agent_id: firstAgentIds[0],
            result_agent_id: firstAgentIds[firstAgentIds.length - 1],
          },
          {
            ...graph,
            type: 'second_team',
            agent_ids: secondAgentIds,
            edges: toChain(secondAgentIds),
            entry_agent_id: secondAgentIds[0],
            result_agent_id: secondAgentIds[secondAgentIds.length - 1],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects graph members outside the cap and edges outside the member set', () => {
    const oversizedAgentIds = Array.from(
      { length: MAX_GRAPH_SUBAGENT_MEMBERS + 1 },
      (_, index) => `agent_${index}`,
    );
    expect(
      agentSubagentsSchema.safeParse({
        enabled: true,
        allowSelf: false,
        graphs: [{ ...graph, agent_ids: oversizedAgentIds }],
      }).success,
    ).toBe(false);
    expect(
      agentSubagentsSchema.safeParse({
        enabled: true,
        allowSelf: false,
        graphs: [
          {
            ...graph,
            edges: [{ from: 'agent_researcher', to: 'agent_unknown', edgeType: 'direct' }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects handoff edges and spawn-type collisions', () => {
    expect(
      agentSubagentsSchema.safeParse({
        enabled: true,
        allowSelf: false,
        graphs: [{ ...graph, edges: [{ ...graph.edges[0], edgeType: 'handoff' }] }],
      }).success,
    ).toBe(false);
    expect(
      agentSubagentsSchema.safeParse({
        enabled: true,
        allowSelf: false,
        agent_ids: ['research_team'],
        graphs: [graph],
      }).success,
    ).toBe(false);
  });
});

describe('agentCreateSchema with subagents', () => {
  const base = {
    provider: 'openAI',
    model: 'gpt-4o-mini',
    tools: [],
  };

  it('passes with subagents omitted', () => {
    const result = agentCreateSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('passes with a valid subagents config', () => {
    const result = agentCreateSchema.safeParse({
      ...base,
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    expect(result.success).toBe(true);
  });

  it.each([true, false])('preserves the explicit file sharing choice %s', (shareFiles) => {
    const result = agentCreateSchema.parse({
      ...base,
      subagents: { enabled: true, shareFiles },
    });
    expect(result.subagents?.shareFiles).toBe(shareFiles);
    expect(agentUpdateSchema.parse({ subagents: { shareFiles } }).subagents?.shareFiles).toBe(
      shareFiles,
    );
  });

  it('accepts the current-agent placeholder in a graph subagent', () => {
    const result = agentCreateSchema.safeParse({
      ...base,
      subagents: {
        enabled: true,
        graphs: [
          {
            type: 'self_review',
            name: 'Self review',
            description: 'Runs the new agent in an isolated context',
            agent_ids: [''],
            edges: [],
            entry_agent_id: '',
            result_agent_id: '',
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects when subagents.agent_ids exceeds the cap', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => `agent_${i}`);
    const result = agentCreateSchema.safeParse({
      ...base,
      subagents: { enabled: true, agent_ids: oversized },
    });
    expect(result.success).toBe(false);
  });

  it('strips runtime-populated files from every tool resource', () => {
    const forgedFile = {
      file_id: 'forged',
      filepath: '/etc/passwd',
      source: 'local',
      metadata: {
        codeEnvRef: {
          kind: 'user',
          id: 'attacker',
          storage_session_id: 'missing',
          file_id: 'missing',
        },
      },
    };
    const result = agentCreateSchema.parse({
      ...base,
      tool_resources: {
        execute_code: { file_ids: ['execute'], files: [forgedFile] },
        file_search: { file_ids: ['search'], files: [forgedFile] },
        image_edit: { file_ids: ['image'], files: [forgedFile] },
        context: { file_ids: ['context'], files: [forgedFile] },
        ocr: { file_ids: ['ocr'], files: [forgedFile] },
      },
    });

    expect(result.tool_resources).toEqual({
      execute_code: { file_ids: ['execute'] },
      file_search: { file_ids: ['search'] },
      image_edit: { file_ids: ['image'] },
      context: { file_ids: ['context'] },
      ocr: { file_ids: ['ocr'] },
    });
  });
});

describe('stateful code environments', () => {
  it.each(['user', 'agent-user', 'conversation'])('accepts %s', (environment) => {
    const result = agentCreateSchema.safeParse({
      provider: 'openAI',
      model: 'gpt-4o-mini',
      tools: [],
      stateful_code_sessions: true,
      stateful_code_environment: environment,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown environment scopes', () => {
    const result = agentUpdateSchema.safeParse({
      stateful_code_environment: 'agent',
    });
    expect(result.success).toBe(false);
  });
});

describe('agentUpdateSchema with subagents', () => {
  it('accepts a partial update with only the disabled flag set', () => {
    const result = agentUpdateSchema.safeParse({
      subagents: { enabled: false, allowSelf: true, agent_ids: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects oversized agent_ids on update', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 3 }, (_, i) => `agent_${i}`);
    const result = agentUpdateSchema.safeParse({
      subagents: { enabled: true, agent_ids: oversized },
    });
    expect(result.success).toBe(false);
  });

  it('strips runtime-populated files from partial updates', () => {
    const result = agentUpdateSchema.parse({
      tool_resources: {
        execute_code: {
          file_ids: ['kept'],
          files: [{ file_id: 'forged', filepath: '/etc/passwd', source: 'local' }],
        },
      },
    });

    expect(result.tool_resources).toEqual({
      execute_code: { file_ids: ['kept'] },
    });
  });
});

describe('validateAgentModel', () => {
  const request = {} as Request<unknown, unknown, unknown>;
  const response = {} as Response;
  const logViolation = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    logViolation.mockClear();
  });

  it('uses the Google catalog for a Vertex AI agent', async () => {
    const result = await validateAgentModel({
      req: request,
      res: response,
      agent: { provider: Providers.VERTEXAI, model: 'gemini-3.7-flash' } as Agent,
      modelsConfig: { [EModelEndpoint.google]: ['gemini-3.7-flash'] },
      logViolation,
    });

    expect(result).toEqual({ isValid: true });
    expect(logViolation).not.toHaveBeenCalled();
  });

  it('uses an exact Vertex AI catalog when configured', async () => {
    const result = await validateAgentModel({
      req: request,
      res: response,
      agent: { provider: Providers.VERTEXAI, model: 'custom-vertex-model' } as Agent,
      modelsConfig: {
        [EModelEndpoint.google]: ['gemini-3.7-flash'],
        [Providers.VERTEXAI]: ['custom-vertex-model'],
      },
      logViolation,
    });

    expect(result).toEqual({ isValid: true });
    expect(logViolation).not.toHaveBeenCalled();
  });

  it('rejects a model absent from the shared Google catalog', async () => {
    const result = await validateAgentModel({
      req: request,
      res: response,
      agent: { provider: Providers.VERTEXAI, model: 'gemini-not-available' } as Agent,
      modelsConfig: { [EModelEndpoint.google]: ['gemini-3.7-flash'] },
      logViolation,
    });

    expect(result.isValid).toBe(false);
    expect(result.error?.message).toContain('illegal_model_request');
    expect(logViolation).toHaveBeenCalledTimes(1);
  });
});
