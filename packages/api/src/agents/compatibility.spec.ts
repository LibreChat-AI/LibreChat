import {
  agentContextFingerprintsMatch,
  createAgentContextFingerprint,
  createAgentEventActorSummary,
  createInitializedAgentContextFingerprint,
  normalizeAgentEventActorDiscoveredTools,
  normalizeAgentEventActorSummary,
  type AgentTurnSemanticContext,
} from './compatibility';

const context = (): AgentTurnSemanticContext => ({
  checkpointerType: 'mongodb',
  approvalPolicy: { enabled: false },
  agents: [
    {
      id: 'agent-1',
      version: 3,
      provider: 'openai',
      model: 'gpt-5',
      instructions: 'Help carefully.',
      modelParameters: { temperature: 0.2 },
      toolDefinitions: [{ name: 'search', schema: { type: 'object' } }],
      execution: { edges: [{ from: 'agent-1', to: 'agent-2' }], recursionLimit: 25 },
      skills: [
        { id: 'skill-b', name: 'beta', version: 2 },
        { id: 'skill-a', name: 'alpha', version: 1 },
      ],
    },
  ],
  memory: [{ scope: 'shared', withoutKeys: 'Prefers concise answers.' }],
});

describe('agent context compatibility', () => {
  it('is deterministic across object-key and set-like Skill ordering', () => {
    const left = context();
    const right = context();
    right.approvalPolicy = { enabled: false };
    right.agents[0].modelParameters = { temperature: 0.2 };
    right.agents[0].skills = [...(right.agents[0].skills ?? [])].reverse();

    expect(createAgentContextFingerprint(left)).toEqual(createAgentContextFingerprint(right));
  });

  it.each([
    ['agent revision', (value: AgentTurnSemanticContext) => (value.agents[0].version = 4)],
    ['instructions', (value: AgentTurnSemanticContext) => (value.agents[0].instructions = 'New')],
    ['model', (value: AgentTurnSemanticContext) => (value.agents[0].model = 'gpt-6')],
    [
      'tool definition',
      (value: AgentTurnSemanticContext) =>
        (value.agents[0].toolDefinitions = [{ name: 'submit', schema: { type: 'object' } }]),
    ],
    [
      'graph topology',
      (value: AgentTurnSemanticContext) =>
        (value.agents[0].execution = {
          edges: [{ from: 'agent-1', to: 'agent-3' }],
          recursionLimit: 25,
        }),
    ],
    [
      'Skill version',
      (value: AgentTurnSemanticContext) =>
        (value.agents[0].skills = [{ id: 'skill-a', name: 'alpha', version: 2 }]),
    ],
    [
      'memory snapshot',
      (value: AgentTurnSemanticContext) =>
        (value.memory = [{ scope: 'shared', withoutKeys: 'Prefers detailed answers.' }]),
    ],
  ])('changes when %s changes', (_label, mutate) => {
    const original = context();
    const changed = context();
    mutate(changed);

    expect(createAgentContextFingerprint(changed).digest).not.toBe(
      createAgentContextFingerprint(original).digest,
    );
  });
  it('invalidates warm context when the project identity or revision changes', () => {
    const original = createAgentContextFingerprint({
      ...context(),
      projectContextKey: 'project:p1:r1',
    });
    const changed = createAgentContextFingerprint({
      ...context(),
      projectContextKey: 'project:p1:r2',
    });
    expect(changed.digest).not.toBe(original.digest);
  });

  it('excludes credential values from compatibility', () => {
    const left = context();
    const right = context();
    left.agents[0].modelParameters = {
      temperature: 0.2,
      apiKey: 'first',
      headers: { 'x-api-key': 'first-header-secret' },
    };
    right.agents[0].modelParameters = {
      apiKey: 'second',
      temperature: 0.2,
      headers: { 'x-api-key': 'second-header-secret' },
    };

    expect(createAgentContextFingerprint(left)).toEqual(createAgentContextFingerprint(right));
  });

  it('preserves credential-named JSON Schema fields in semantic tool definitions', () => {
    const left = context();
    const right = context();
    left.agents[0].toolDefinitions = [
      {
        name: 'login',
        schema: { type: 'object', properties: { password: { type: 'string' } } },
      },
    ];
    right.agents[0].toolDefinitions = [
      {
        name: 'login',
        schema: { type: 'object', properties: { password: { type: 'number' } } },
      },
    ];

    expect(createAgentContextFingerprint(left).digest).not.toBe(
      createAgentContextFingerprint(right).digest,
    );
  });

  it('fails compatibility closed for a missing or unknown stored version', () => {
    const current = createAgentContextFingerprint(context());

    expect(agentContextFingerprintsMatch(undefined, current)).toBe(false);
    expect(
      agentContextFingerprintsMatch({ ...current, version: current.version + 1 }, current),
    ).toBe(false);
    expect(agentContextFingerprintsMatch(current, current)).toBe(true);
  });

  it('projects initialized Skill identities without duplicate reads', () => {
    const fingerprint = createInitializedAgentContextFingerprint({
      agents: [
        {
          id: 'agent-1',
          manualSkillPrimes: [
            { _id: 'skill-1', name: 'analysis', version: 4 },
            { _id: 'skill-1', name: 'analysis', version: 4 },
          ],
        },
      ],
    });
    const changed = createInitializedAgentContextFingerprint({
      agents: [
        {
          id: 'agent-1',
          manualSkillPrimes: [{ _id: 'skill-1', name: 'analysis', version: 5 }],
        },
      ],
    });

    expect(changed.digest).not.toBe(fingerprint.digest);
  });

  it('invalidates initialized context when the code execution route changes', () => {
    const fingerprint = (executionRouteKey: string) =>
      createInitializedAgentContextFingerprint({
        agents: [{ id: 'agent-1', execution: { executionRouteKey } }],
      });

    expect(fingerprint('stateful:first').digest).not.toBe(fingerprint('stateful:second').digest);
  });

  it('invalidates a constant-version deployment Skill when its body changes', () => {
    const fingerprint = (body: string) =>
      createInitializedAgentContextFingerprint({
        agents: [
          {
            id: 'agent-1',
            alwaysApplySkillPrimes: [
              { _id: 'deployment:analysis', name: 'analysis', version: 1, body },
            ],
          },
        ],
      });

    expect(fingerprint('First instructions').digest).not.toBe(
      fingerprint('Updated instructions').digest,
    );
  });

  it('normalizes bounded tool discoveries and fingerprints the active set', () => {
    expect(normalizeAgentEventActorDiscoveredTools(['zeta', 'alpha', 'zeta'])).toEqual([
      'alpha',
      'zeta',
    ]);
    const left = context();
    const reordered = context();
    const changed = context();
    left.discoveredToolNames = ['zeta', 'alpha'];
    reordered.discoveredToolNames = ['alpha', 'zeta', 'alpha'];
    changed.discoveredToolNames = ['alpha', 'gamma'];

    expect(createAgentContextFingerprint(left)).toEqual(createAgentContextFingerprint(reordered));
    expect(createAgentContextFingerprint(left).digest).not.toBe(
      createAgentContextFingerprint(changed).digest,
    );
    expect(() =>
      normalizeAgentEventActorDiscoveredTools(
        Array.from({ length: 129 }, (_, index) => `tool-${index}`),
      ),
    ).toThrow('exceeds 128');
  });

  it('invalidates a deferred tool when its registry definition changes', () => {
    const fingerprint = (description: string) =>
      createInitializedAgentContextFingerprint({
        agents: [
          {
            id: 'agent-1',
            toolRegistryDefinitions: [{ name: 'deferred_tool', description, defer_loading: true }],
          },
        ],
      });

    expect(fingerprint('First schema').digest).not.toBe(fingerprint('Updated schema').digest);
  });
});

describe('event actor summary state', () => {
  it('stamps the provenance version on a summary a run records', () => {
    expect(
      createAgentEventActorSummary({ text: 'Earlier turns, compacted.', tokenCount: 12 }),
    ).toEqual({ text: 'Earlier turns, compacted.', tokenCount: 12, version: 1 });
  });

  it.each([
    ['nothing to stamp', undefined],
    ['a null summary', null],
  ])('records %s as no state at all', (_label, summary) => {
    expect(createAgentEventActorSummary(summary)).toBeUndefined();
  });

  /** A summary the formatter reconstructed from durable history arrives in the
   *  SDK's shape; stamping it is what keeps the next event on the warm path. */
  it('stamps a summary inherited in the SDK shape', () => {
    expect(createAgentEventActorSummary({ text: 'Reconstructed.', tokenCount: 9 })).toMatchObject({
      version: 1,
    });
  });
  it('restores a versioned summary for a warm continuation', () => {
    const stored = { text: 'Earlier turns, compacted.', tokenCount: 12, version: 1 };

    expect(normalizeAgentEventActorSummary(stored)).toEqual(stored);
  });

  it('treats an absent summary as nothing to carry forward', () => {
    expect(normalizeAgentEventActorSummary(undefined)).toBeUndefined();
  });

  /** A state written before the version kept only `{ text, tokenCount }`, so a
   *  round that failed reads exactly like a checkpoint. Refusing it sends the
   *  run down the cold path, which rebuilds from durable history. */
  it.each([
    ['no version, as written before it existed', { text: 'Half a checkpoint', tokenCount: 4 }],
    [
      'a version this build does not know',
      { text: 'Half a checkpoint', tokenCount: 4, version: 2 },
    ],
    ['empty text', { text: '', tokenCount: 4, version: 1 }],
    ['a negative token count', { text: 'Checkpoint', tokenCount: -1, version: 1 }],
  ])('refuses a stored summary with %s', (_label, stored) => {
    expect(() => normalizeAgentEventActorSummary(stored)).toThrow(
      'Event actor summary state is invalid',
    );
  });
});

describe('retained-answer checkpoint compatibility', () => {
  it('rebuilds warm state after enabling, disabling, changing the budget, or upgrading legacy context', () => {
    const base = { agents: [{ id: 'agent-1' }] };
    const enabled = createInitializedAgentContextFingerprint({
      ...base,
      retainedAnswers: { enabled: true, maxTokens: 4096 },
    });
    for (const retainedAnswers of [
      undefined,
      { enabled: false, maxTokens: 4096 },
      { enabled: true, maxTokens: 1024 },
    ]) {
      expect(
        createInitializedAgentContextFingerprint({ ...base, retainedAnswers }).digest,
      ).not.toBe(enabled.digest);
    }
    expect(
      createInitializedAgentContextFingerprint({
        ...base,
        retainedAnswers: { enabled: true, maxTokens: 4096 },
      }).digest,
    ).toBe(enabled.digest);
  });
});
