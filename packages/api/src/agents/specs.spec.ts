import { FileSources } from 'librechat-data-provider';
import type { TModelSpec, GraphEdge } from 'librechat-data-provider';
import {
  modelSpecAgentId,
  getModelSpecHandoffTargets,
  loadModelSpecHandoff,
  validateHandoffReferences,
} from './specs';

const spec = {
  name: 'research____1',
  label: 'Research Assistant',
  handoff: true,
  showInMenu: false,
  executeCode: true,
  skills: true,
  mcpServers: ['research'],
  preset: {
    endpoint: 'openAI',
    model: 'gpt-4o',
    promptPrefix: 'Research for {{current_user}}.',
    temperature: 0.2,
  },
} as TModelSpec;
const id = modelSpecAgentId(spec.name);
const req = {
  user: { id: 'user-1', name: 'Ada', role: 'USER' },
  config: {
    config: {},
    fileStrategy: FileSources.local as const,
    imageOutputType: 'png' as const,
    modelSpecs: { list: [spec] },
  },
  body: {
    promptPrefix: 'Wrong prompt',
    ephemeralAgent: { execute_code: false, skills: false, mcp: ['wrong'] },
  },
};

test('offers an opted-in hidden preset without disclosing its instructions or tools', () => {
  expect(getModelSpecHandoffTargets([spec])).toEqual([
    {
      id,
      name: 'Research Assistant',
      provider: 'openAI',
      model: 'gpt-4o',
      avatar: null,
    },
  ]);
  expect(getModelSpecHandoffTargets([{ ...spec, handoff: false }])).toEqual([]);
  expect(
    getModelSpecHandoffTargets([
      { ...spec, preset: { endpoint: 'agents', agent_id: 'agent_saved' } },
    ]),
  ).toEqual([]);
  expect(id).not.toMatch(/____1$/);
});

test('loads current server-owned settings without inheriting the primary prompt or toggles', async () => {
  const agent = await loadModelSpecHandoff(id, req);
  expect(agent).toMatchObject({
    id,
    name: 'Research Assistant',
    provider: 'openAI',
    model: 'gpt-4o',
    instructions: 'Research for {{current_user}}.',
    skills_enabled: true,
  });
  expect(agent?.tools).toContain('execute_code');
  expect(agent?.tools).toContain('sys__all__sys_mcp_research');
  expect(agent?.tools?.some((tool) => tool.includes('wrong'))).toBe(false);
  expect(req.body.ephemeralAgent?.mcp).toEqual(['wrong']);
});

test('fails closed after a target is disabled, removed, or absent from the viewer config', async () => {
  expect(
    await loadModelSpecHandoff(id, { ...req, config: { ...req.config, modelSpecs: { list: [] } } }),
  ).toBeNull();
  expect(
    await loadModelSpecHandoff(id, {
      ...req,
      config: { ...req.config, modelSpecs: { list: [{ ...spec, handoff: false }] } },
    }),
  ).toBeNull();
});

test('validates config references while preserving saved-agent ACL failures and create self references', async () => {
  const classifySavedReferences = jest
    .fn()
    .mockResolvedValue({ missing: ['new'], unauthorized: ['agent_denied'] });
  const edges: GraphEdge[] = [
    { from: 'new', to: id, edgeType: 'handoff' },
    { from: 'new', to: 'agent_denied' },
  ];
  expect(
    await validateHandoffReferences({
      edges,
      specs: [spec],
      allowedMissingIds: new Set(['new']),
      classifySavedReferences,
    }),
  ).toEqual({ missing: [], unauthorized: ['agent_denied'] });
  expect(classifySavedReferences).toHaveBeenCalledWith(['new', 'agent_denied']);
});

test('rejects unknown, disabled, direct, and fan-out spec references at save time', async () => {
  const classifySavedReferences = async () => ({ missing: [], unauthorized: [] });
  for (const edges of [
    [{ from: 'agent_parent', to: id, edgeType: 'direct' as const }],
    [{ from: 'agent_parent', to: [id] }],
    [{ from: 'agent_parent', to: modelSpecAgentId('absent') }],
  ]) {
    const result = await validateHandoffReferences({
      edges,
      specs: [spec],
      allowedMissingIds: new Set(),
      classifySavedReferences,
    });
    expect(result.missing).toHaveLength(1);
  }
});

test('keeps graph and provider tool identities safe and bounded for arbitrary spec names', () => {
  const id = modelSpecAgentId('Research / 分析: ' + 'a'.repeat(100));
  expect('lc_transfer_to_' + id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(id).toBe(modelSpecAgentId('Research / 分析: ' + 'a'.repeat(100)));
  expect(id).not.toBe(modelSpecAgentId('Research / 分析: ' + 'a'.repeat(101)));
});
