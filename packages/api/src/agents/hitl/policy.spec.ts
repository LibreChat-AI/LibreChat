import type { Agents, TToolApprovalPolicy } from 'librechat-data-provider';
import {
  resolveToolApprovalPolicy,
  isHITLEnabled,
  healToolApprovalPolicy,
  collectAliasMatcherNames,
  buildAliasMatcherPattern,
  mapToolApprovalPolicy,
  buildToolApprovalPayload,
  buildAskUserQuestionPayload,
  buildPendingAction,
  isToolApprovalPayloadValid,
  toClientPendingAction,
  computeAgentRequestFingerprint,
  computeLegacyAgentRequestFingerprint,
  captureResumeModelParameters,
  sanitizeResumeModelParameters,
  pickResumeContext,
  applyResumeContext,
  applyResumeModelParameters,
  exemptAskUserQuestionFromApproval,
  isToolApprovalPauseCapable,
  isToolDeniedByApprovalPolicy,
} from './policy';

describe('isToolApprovalPauseCapable', () => {
  it('recognizes the default ask fallback and explicit ask rules', () => {
    expect(isToolApprovalPauseCapable({ enabled: true })).toBe(true);
    expect(isToolApprovalPauseCapable({ enabled: true, mode: 'bypass', ask: ['write_*'] })).toBe(
      true,
    );
  });

  it('excludes policies that can only allow or deny', () => {
    expect(isToolApprovalPauseCapable({ enabled: true, mode: 'bypass' })).toBe(false);
    expect(isToolApprovalPauseCapable({ enabled: true, mode: 'dontAsk' })).toBe(false);
    expect(isToolApprovalPauseCapable({ enabled: true, allow: ['*'] })).toBe(false);
    expect(isToolApprovalPauseCapable({ enabled: true, deny: ['*'], ask: ['write_*'] }, true)).toBe(
      false,
    );
  });

  it('treats a programmatic hook as pause-capable when policy does not deny every tool', () => {
    expect(isToolApprovalPauseCapable({ enabled: true, mode: 'bypass' }, true)).toBe(true);
  });

  it('intersects approval rules with the selected run tool surface', () => {
    const policy = { enabled: true, mode: 'bypass' as const, ask: ['write_*'] };
    expect(isToolApprovalPauseCapable(policy, false, [])).toBe(false);
    expect(isToolApprovalPauseCapable(policy, false, ['read_file'])).toBe(false);
    expect(isToolApprovalPauseCapable(policy, false, ['write_file'])).toBe(true);
    expect(isToolApprovalPauseCapable({ enabled: true }, false, ['read_file'])).toBe(true);
  });

  it('keeps deny precedence when a matching programmatic hook can ask', () => {
    const policy = { enabled: true, mode: 'bypass' as const, deny: ['delete_*'] };
    expect(isToolApprovalPauseCapable(policy, true, ['delete_file'])).toBe(false);
    expect(isToolApprovalPauseCapable(policy, true, ['write_file'])).toBe(true);
  });
});

describe('isToolDeniedByApprovalPolicy', () => {
  it('matches exact and wildcard denies only when approval is enabled', () => {
    expect(
      isToolDeniedByApprovalPolicy({ enabled: true, deny: ['ask_*'] }, 'ask_user_question'),
    ).toBe(true);
    expect(
      isToolDeniedByApprovalPolicy({ enabled: true, deny: ['write_*'] }, 'ask_user_question'),
    ).toBe(false);
    expect(
      isToolDeniedByApprovalPolicy({ enabled: false, deny: ['ask_*'] }, 'ask_user_question'),
    ).toBe(false);
  });
});

describe('resolveToolApprovalPolicy', () => {
  test('returns the endpoint policy unchanged when BYOM is not active', () => {
    const endpoint: TToolApprovalPolicy = { enabled: true, mode: 'default', deny: ['rm'] };
    // Identity, not a copy — non-BYOM behavior remains unchanged.
    expect(resolveToolApprovalPolicy({ endpoint })).toBe(endpoint);
  });

  test('returns undefined when there is no endpoint policy', () => {
    expect(resolveToolApprovalPolicy({})).toBeUndefined();
    expect(resolveToolApprovalPolicy({ endpoint: undefined })).toBeUndefined();
  });

  test('enables the safe BYOM baseline without affecting unrelated tools', () => {
    expect(resolveToolApprovalPolicy({ attachedCodeEnvironment: true })).toEqual({
      enabled: true,
      mode: 'bypass',
    });
  });

  test.each(['default', 'dontAsk', 'bypass'] as const)(
    'preserves an enabled endpoint %s policy when BYOM is active',
    (mode) => {
      const endpoint: TToolApprovalPolicy = {
        enabled: true,
        mode,
        deny: ['dangerous_tool'],
      };
      expect(resolveToolApprovalPolicy({ endpoint, attachedCodeEnvironment: true })).toBe(endpoint);
    },
  );

  test('uses the BYOM bypass baseline for a configured but inactive endpoint policy', () => {
    expect(
      resolveToolApprovalPolicy({
        endpoint: { mode: 'dontAsk', deny: ['dangerous_tool'] },
        attachedCodeEnvironment: true,
      }),
    ).toEqual({
      enabled: true,
      mode: 'bypass',
      deny: ['dangerous_tool'],
    });
  });

  test('preserves the administrator emergency override for BYOM', () => {
    const endpoint: TToolApprovalPolicy = { enabled: false };
    expect(resolveToolApprovalPolicy({ endpoint, attachedCodeEnvironment: true })).toBe(endpoint);
  });

  test('ignores the reserved agent/skills layers for now (behaviour-preserving)', () => {
    const endpoint: TToolApprovalPolicy = { enabled: true, mode: 'bypass' };
    const resolved = resolveToolApprovalPolicy({
      endpoint,
      agent: { enabled: true, mode: 'default', ask: ['shell'] },
      skills: [{ deny: ['delete_*'] }],
    });
    // Until merge lands, the result must still be exactly the endpoint policy so
    // enabling the seam can't change runtime behaviour.
    expect(resolved).toBe(endpoint);
  });
});

describe('isHITLEnabled', () => {
  test('default-off when no policy configured', () => {
    expect(isHITLEnabled(undefined)).toBe(false);
  });

  test('default-off when policy is configured but `enabled` is omitted', () => {
    expect(isHITLEnabled({})).toBe(false);
    expect(isHITLEnabled({ mode: 'default', allow: ['read_*'] })).toBe(false);
  });

  test('explicit false is off', () => {
    expect(isHITLEnabled({ enabled: false })).toBe(false);
  });

  test('explicit true is on', () => {
    expect(isHITLEnabled({ enabled: true })).toBe(true);
  });
});

describe('mapToolApprovalPolicy', () => {
  test('returns undefined when no policy is configured', () => {
    expect(mapToolApprovalPolicy(undefined)).toBeUndefined();
  });

  test('returns undefined when policy is empty after stripping enabled', () => {
    expect(mapToolApprovalPolicy({ enabled: true })).toBeUndefined();
    expect(mapToolApprovalPolicy({ enabled: false })).toBeUndefined();
  });

  test('returns undefined when only empty arrays are present', () => {
    expect(mapToolApprovalPolicy({ allow: [], deny: [], ask: [] })).toBeUndefined();
  });

  test('passes through mode/allow/deny/ask/reason verbatim', () => {
    const policy: TToolApprovalPolicy = {
      mode: 'dontAsk',
      allow: ['read_*', 'mcp:github:*'],
      deny: ['delete_*'],
      ask: ['execute_*'],
      reason: 'Tool {tool} requires review',
    };
    expect(mapToolApprovalPolicy(policy)).toEqual({
      mode: 'dontAsk',
      allow: ['read_*', 'mcp:github:*'],
      deny: ['delete_*'],
      ask: ['execute_*'],
      reason: 'Tool {tool} requires review',
    });
  });

  test('strips enabled regardless of value (LibreChat-only field)', () => {
    expect(mapToolApprovalPolicy({ enabled: false, mode: 'bypass' })).toEqual({
      mode: 'bypass',
    });
    expect(mapToolApprovalPolicy({ enabled: true, allow: ['read_*'] })).toEqual({
      allow: ['read_*'],
    });
  });

  test('omits empty list fields from the output', () => {
    expect(mapToolApprovalPolicy({ mode: 'default', allow: [], deny: ['rm'] })).toEqual({
      mode: 'default',
      deny: ['rm'],
    });
  });
});

describe('buildToolApprovalPayload', () => {
  const calls = [
    {
      name: 'shell',
      arguments: { command: 'ls' },
      tool_call_id: 'call_abc',
      description: 'List files',
    },
  ];

  test('produces a tool_approval-discriminated payload', () => {
    const payload = buildToolApprovalPayload(calls);
    expect(payload.type).toBe('tool_approval');
    expect(payload.action_requests).toEqual([
      {
        name: 'shell',
        arguments: { command: 'ls' },
        tool_call_id: 'call_abc',
        description: 'List files',
      },
    ]);
  });

  test("default decisions exclude 'respond' (reserved for AskUserQuestion semantics)", () => {
    const payload = buildToolApprovalPayload(calls);
    expect(payload.review_configs[0].allowed_decisions).toEqual(['approve', 'reject', 'edit']);
  });

  test('respects per-tool decision overrides', () => {
    const payload = buildToolApprovalPayload(calls, {
      shell: ['approve', 'reject'],
    });
    expect(payload.review_configs[0].allowed_decisions).toEqual(['approve', 'reject']);
  });

  test('produces one review_config per call, in order', () => {
    const payload = buildToolApprovalPayload([
      { name: 'a', arguments: {}, tool_call_id: '1' },
      { name: 'b', arguments: {}, tool_call_id: '2' },
    ]);
    expect(payload.review_configs.map((r) => r.action_name)).toEqual(['a', 'b']);
  });

  test('carries tool_call_id on each review_config (join key for duplicate-tool batches)', () => {
    const payload = buildToolApprovalPayload([
      { name: 'mcp:server:search', arguments: { q: 'a' }, tool_call_id: 'call_1' },
      { name: 'mcp:server:search', arguments: { q: 'b' }, tool_call_id: 'call_2' },
    ]);
    expect(payload.review_configs).toEqual([
      {
        action_name: 'mcp:server:search',
        tool_call_id: 'call_1',
        allowed_decisions: ['approve', 'reject', 'edit'],
      },
      {
        action_name: 'mcp:server:search',
        tool_call_id: 'call_2',
        allowed_decisions: ['approve', 'reject', 'edit'],
      },
    ]);
  });
});

describe('buildAskUserQuestionPayload', () => {
  test('produces an ask_user_question-discriminated payload', () => {
    const payload = buildAskUserQuestionPayload({
      question: 'Which environment?',
      options: [
        { label: 'Staging', value: 'staging' },
        { label: 'Production', value: 'production' },
      ],
    });
    expect(payload.type).toBe('ask_user_question');
    expect(payload.question.question).toBe('Which environment?');
    expect(payload.question.options).toHaveLength(2);
  });

  test('options are optional', () => {
    const payload = buildAskUserQuestionPayload({ question: 'Free-form?' });
    expect(payload.question.options).toBeUndefined();
  });
});

describe('buildPendingAction', () => {
  const ctx = {
    streamId: 'stream-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    responseMessageId: 'msg-1',
  };

  const toolApprovalPayload: Agents.ToolApprovalInterruptPayload = {
    type: 'tool_approval',
    action_requests: [{ name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_abc' }],
    review_configs: [
      { action_name: 'shell', tool_call_id: 'call_abc', allowed_decisions: ['approve', 'reject'] },
    ],
  };

  test('wraps a tool_approval payload with job context', () => {
    const action = buildPendingAction(toolApprovalPayload, ctx);
    expect(action.streamId).toBe('stream-1');
    expect(action.conversationId).toBe('conv-1');
    expect(action.runId).toBe('run-1');
    expect(action.responseMessageId).toBe('msg-1');
    expect(action.payload).toBe(toolApprovalPayload);
    expect(typeof action.createdAt).toBe('number');
  });

  test('rejects duplicate tool-call ids before the approval is persisted', () => {
    const duplicatePayload: Agents.ToolApprovalInterruptPayload = {
      type: 'tool_approval',
      action_requests: [
        { name: 'shell', arguments: { command: 'rm marker' }, tool_call_id: 'duplicate' },
        { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'duplicate' },
      ],
      review_configs: [
        {
          action_name: 'shell',
          tool_call_id: 'duplicate',
          allowed_decisions: ['approve', 'reject'],
        },
        {
          action_name: 'shell',
          tool_call_id: 'duplicate',
          allowed_decisions: ['approve', 'reject'],
        },
      ],
    };

    expect(isToolApprovalPayloadValid(duplicatePayload)).toBe(false);
    expect(() => buildPendingAction(duplicatePayload, ctx)).toThrow(
      'Invalid tool approval payload',
    );
  });

  test('rejects review policies that do not map one-to-one to the requested calls', () => {
    const mismatchedPayload: Agents.ToolApprovalInterruptPayload = {
      type: 'tool_approval',
      action_requests: [
        { name: 'read_file', arguments: { path: 'safe.txt' }, tool_call_id: 'call-1' },
      ],
      review_configs: [
        {
          action_name: 'read_file',
          tool_call_id: 'call-2',
          allowed_decisions: ['approve', 'reject'],
        },
      ],
    };

    expect(isToolApprovalPayloadValid(mismatchedPayload)).toBe(false);
    expect(() => buildPendingAction(mismatchedPayload, ctx)).toThrow(
      'Invalid tool approval payload',
    );
  });

  test('wraps an ask_user_question payload with the same envelope', () => {
    const askPayload: Agents.AskUserQuestionInterruptPayload = {
      type: 'ask_user_question',
      question: { question: 'Which env?' },
    };
    const action = buildPendingAction(askPayload, ctx);
    expect(action.payload.type).toBe('ask_user_question');
  });

  test('generates a uuid actionId by default', () => {
    const a = buildPendingAction(toolApprovalPayload, ctx);
    const b = buildPendingAction(toolApprovalPayload, ctx);
    expect(a.actionId).not.toBe(b.actionId);
    expect(a.actionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('honours an explicit actionId', () => {
    const action = buildPendingAction(toolApprovalPayload, { ...ctx, actionId: 'fixed-id' });
    expect(action.actionId).toBe('fixed-id');
  });

  test('sets expiresAt only when ttlMs is provided', () => {
    const without = buildPendingAction(toolApprovalPayload, ctx);
    expect(without.expiresAt).toBeUndefined();

    const ttl = 5_000;
    const before = Date.now();
    const withTtl = buildPendingAction(toolApprovalPayload, { ...ctx, ttlMs: ttl });
    const after = Date.now();
    expect(withTtl.expiresAt).toBeDefined();
    expect(withTtl.expiresAt).toBeGreaterThanOrEqual(before + ttl);
    expect(withTtl.expiresAt).toBeLessThanOrEqual(after + ttl);
  });

  test('honours ttlMs 0 as immediate expiry', () => {
    const before = Date.now();
    const action = buildPendingAction(toolApprovalPayload, { ...ctx, ttlMs: 0 });
    const after = Date.now();

    expect(action.expiresAt).toBeDefined();
    expect(action.expiresAt).toBeGreaterThanOrEqual(before);
    expect(action.expiresAt).toBeLessThanOrEqual(after);
  });

  test('caps the TTL at an inherited absolute deadline without a second clock read', () => {
    const deadline = Date.now() + 1_000;
    const action = buildPendingAction(toolApprovalPayload, {
      ...ctx,
      ttlMs: 5_000,
      expiresAt: new Date(deadline),
    });

    expect(action.expiresAt).toBe(deadline);
  });
});

describe('toClientPendingAction', () => {
  const payload: Agents.ToolApprovalInterruptPayload = {
    type: 'tool_approval',
    action_requests: [{ name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_abc' }],
    review_configs: [
      { action_name: 'shell', tool_call_id: 'call_abc', allowed_decisions: ['approve', 'reject'] },
    ],
  };

  test('omits server-only replay state, keeping the fields the client renders from', () => {
    const full = buildPendingAction(payload, {
      streamId: 'stream-1',
      conversationId: 'conv-1',
      requestFingerprint: 'fp-hash',
      requestFingerprintV2: 'fp-v2-hash',
      resumeContext: {
        endpoint: 'agents',
        model_parameters: { temperature: 0.5 },
      },
      codeExecutionBinding: {
        version: 1,
        targets: [{ agentId: 'agent-1', targetHash: 'a'.repeat(64) }],
      },
    });

    const clientSafe = toClientPendingAction(full);
    expect(clientSafe).toBeDefined();
    expect(clientSafe?.resumeContext).toBeUndefined();
    expect(clientSafe?.requestFingerprint).toBeUndefined();
    expect(clientSafe?.requestFingerprintV2).toBeUndefined();
    expect(clientSafe?.codeExecutionBinding).toBeUndefined();
    expect(clientSafe?.actionId).toBe(full.actionId);
    expect(clientSafe?.streamId).toBe('stream-1');
    expect(clientSafe?.payload).toBe(full.payload);
    // Non-mutating: the stored record keeps its replay state for the resume route.
    expect(full.resumeContext).toBeDefined();
    expect(full.requestFingerprint).toBe('fp-hash');
    expect(full.requestFingerprintV2).toBe('fp-v2-hash');
    expect(full.codeExecutionBinding).toEqual({
      version: 1,
      targets: [{ agentId: 'agent-1', targetHash: 'a'.repeat(64) }],
    });
  });

  test('passes through nullish input', () => {
    expect(toClientPendingAction(undefined)).toBeUndefined();
    expect(toClientPendingAction(null)).toBeUndefined();
  });
});

describe('sanitizeResumeModelParameters', () => {
  test('strips provider credentials and transport config across provider shapes', () => {
    const sanitized = sanitizeResumeModelParameters({
      model: 'gpt-5',
      temperature: 0.2,
      maxTokens: 1024,
      max_tokens: 512,
      apiKey: 'sk-server-secret',
      azureOpenAIApiKey: 'azure-secret',
      azureOpenAIApiInstanceName: 'internal-resource',
      anthropicApiUrl: 'https://internal-gateway.example',
      configuration: {
        baseURL: 'https://internal-gateway.example',
        defaultHeaders: { Authorization: 'Bearer server-secret' },
      },
      clientOptions: { defaultHeaders: { 'x-api-key': 'anthropic-secret' } },
      customHeaders: { 'Ocp-Apim-Subscription-Key': 'gateway-secret' },
      authOptions: { credentials: { private_key: 'google-secret' } },
      credentials: { accessKeyId: 'aws-id', secretAccessKey: 'aws-secret' },
      client: { config: { token: { token: 'bedrock-bearer' } } },
      endpoint: 'aiplatform.eu.rep.googleapis.com',
      endpointHost: 'vpce.internal.example',
      baseURL: 'https://internal-gateway.example',
    });

    expect(sanitized).toEqual({
      model: 'gpt-5',
      temperature: 0.2,
      maxTokens: 1024,
      max_tokens: 512,
    });
  });

  test('keeps user-level params while stripping nested secret keys from custom params', () => {
    const sanitized = sanitizeResumeModelParameters({
      maxTokens: 2048,
      stop: ['a', 'b'],
      custom: { safe: true, api_key: 'x', token: 'y' },
    });

    expect(sanitized).toEqual({
      maxTokens: 2048,
      stop: ['a', 'b'],
      custom: { safe: true },
    });
  });

  test('drops function values and returns undefined for non-object input', () => {
    const sanitized = sanitizeResumeModelParameters({
      temperature: 1,
      fetch: () => undefined,
    });
    expect(sanitized).toEqual({ temperature: 1 });

    expect(sanitizeResumeModelParameters(undefined)).toBeUndefined();
    expect(sanitizeResumeModelParameters(null)).toBeUndefined();
    expect(sanitizeResumeModelParameters('sk-secret')).toBeUndefined();
    expect(sanitizeResumeModelParameters(['sk-secret'])).toBeUndefined();
  });

  test('normalizes the resolved Anthropic object `thinking` back to the request-body form (#14253)', () => {
    // Opus/Sonnet 4+ resolve `thinking` to a provider-format object; replaying it
    // verbatim fails the compact-convo `thinking: z.boolean()` field and its
    // `.catch(()=>({}))` drops model/spec → missing_model.
    expect(
      sanitizeResumeModelParameters({
        model: 'claude-opus-4-20250514',
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
    ).toEqual({ model: 'claude-opus-4-20250514', thinking: true, thinkingBudget: 2048 });

    expect(sanitizeResumeModelParameters({ thinking: { type: 'disabled' } })).toEqual({
      thinking: false,
    });

    // Boolean thinking (and an explicit thinkingBudget) are left untouched.
    expect(sanitizeResumeModelParameters({ thinking: true, thinkingBudget: 4096 })).toEqual({
      thinking: true,
      thinkingBudget: 4096,
    });
    expect(
      sanitizeResumeModelParameters({
        thinking: { type: 'enabled', budget_tokens: 2048 },
        thinkingBudget: 4096,
      }),
    ).toEqual({ thinking: true, thinkingBudget: 4096 });
  });

  test('preserves an explicit adaptive `display` as thinkingDisplay (#14253)', () => {
    // Opus 4.7+ adaptive configs carry `display`; dropping it would demote an
    // explicit 'omitted' choice back to the default ('summarized') on resume.
    expect(
      sanitizeResumeModelParameters({ thinking: { type: 'adaptive', display: 'omitted' } }),
    ).toEqual({ thinking: true, thinkingDisplay: 'omitted' });
    // An explicit top-level thinkingDisplay wins over the object's display.
    expect(
      sanitizeResumeModelParameters({
        thinking: { type: 'adaptive', display: 'summarized' },
        thinkingDisplay: 'omitted',
      }),
    ).toEqual({ thinking: true, thinkingDisplay: 'omitted' });
  });

  test('lifts adaptive effort out of invocationKwargs.output_config (#14253)', () => {
    // configureReasoning stores a non-default effort at
    // invocationKwargs.output_config.effort; the request-body schema only accepts
    // the top-level field, so replaying without the lift loses the effort choice.
    expect(
      sanitizeResumeModelParameters({
        thinking: { type: 'adaptive' },
        invocationKwargs: { metadata: { user_id: 'u1' }, output_config: { effort: 'max' } },
      }),
    ).toEqual({ thinking: true, effort: 'max' });
    // An existing top-level effort wins; invocationKwargs is always dropped.
    expect(
      sanitizeResumeModelParameters({
        effort: 'low',
        invocationKwargs: { output_config: { effort: 'max' } },
      }),
    ).toEqual({ effort: 'low' });
    expect(
      sanitizeResumeModelParameters({ invocationKwargs: { metadata: { user_id: 'u1' } } }),
    ).toEqual({});
  });
});

describe('captureResumeModelParameters', () => {
  test('captures UI-form body params the resolved llmConfig renames or drops (#14253)', () => {
    // Anthropic resolution renames maxOutputTokens → maxTokens and stop → stopSequences;
    // replaying only the resolved form would silently reset those on resume.
    expect(
      captureResumeModelParameters(
        {
          text: 'hi',
          maxOutputTokens: 8192,
          stop: ['END'],
          temperature: 0.3,
          maxContextTokens: 50000,
        },
        { model: 'claude-opus-4', temperature: 0.3, maxTokens: 8192, stopSequences: ['END'] },
      ),
    ).toEqual({
      model: 'claude-opus-4',
      temperature: 0.3,
      maxTokens: 8192,
      stopSequences: ['END'],
      maxOutputTokens: 8192,
      stop: ['END'],
      maxContextTokens: 50000,
    });
  });

  test('body values win over the normalized resolved values', () => {
    expect(
      captureResumeModelParameters(
        { thinking: false, effort: 'low' },
        { thinking: { type: 'adaptive' }, invocationKwargs: { output_config: { effort: 'max' } } },
      ),
    ).toEqual({ thinking: false, effort: 'low' });
  });

  test('resolved params still fill gaps the body lacks (normalized to UI form)', () => {
    expect(
      captureResumeModelParameters(
        {},
        {
          thinking: { type: 'adaptive', display: 'omitted' },
          invocationKwargs: { output_config: { effort: 'max' } },
        },
      ),
    ).toEqual({ thinking: true, thinkingDisplay: 'omitted', effort: 'max' });
    expect(captureResumeModelParameters({ temperature: 0.5 }, undefined)).toEqual({
      temperature: 0.5,
    });
  });

  test('does not capture a provider transport endpoint for request replay (#14946)', () => {
    expect(
      captureResumeModelParameters(
        { temperature: 0.2 },
        {
          model: 'gemini-3.7-flash',
          temperature: 0.2,
          endpoint: 'aiplatform.eu.rep.googleapis.com',
        },
      ),
    ).toEqual({ model: 'gemini-3.7-flash', temperature: 0.2 });
  });

  test('only replays schema-known generation params; identity fields stay owned elsewhere', () => {
    // model/spec/modelLabel/promptPrefix ride RESUME_CONTEXT_KEYS; text/files/etc.
    // never reach model_parameters (parseCompactConvo strips them).
    expect(
      captureResumeModelParameters(
        {
          model: 'gpt-5',
          spec: 'my-spec',
          modelLabel: 'My Opus',
          promptPrefix: 'be nice',
          text: 'hello',
          conversationId: 'c1',
          top_p: 0.9,
        },
        undefined,
      ),
    ).toEqual({ top_p: 0.9 });
    expect(captureResumeModelParameters({ text: 'hello' }, undefined)).toBeUndefined();
  });

  test('sanitizes sensitive keys inside captured body values', () => {
    expect(
      captureResumeModelParameters(
        { additionalModelRequestFields: { apiKey: 'sk-live', anthropic_beta: ['x'] } },
        undefined,
      ),
    ).toEqual({ additionalModelRequestFields: { anthropic_beta: ['x'] } });
  });
});

describe('computeAgentRequestFingerprint', () => {
  it('is stable for the same graph-determining fields (ignoring other body keys)', () => {
    const a = computeAgentRequestFingerprint({
      endpoint: 'agents',
      agent_id: 'agent-1',
      model: 'gpt',
    });
    // Extra/unknown fields on the body must not change the fingerprint.
    const b = computeAgentRequestFingerprint({
      endpoint: 'agents',
      agent_id: 'agent-1',
      model: 'gpt',
      ...({ conversationId: 'c', decisions: [] } as Record<string, unknown>),
    });
    expect(a).toBe(b);
  });

  it('differs when a graph-determining field changes', () => {
    const base = { endpoint: 'agents', agent_id: 'agent-1', model: 'gpt' };
    expect(computeAgentRequestFingerprint(base)).not.toBe(
      computeAgentRequestFingerprint({ ...base, model: 'other' }),
    );
    expect(computeAgentRequestFingerprint(base)).not.toBe(
      computeAgentRequestFingerprint({ ...base, agent_id: 'agent-2' }),
    );
    expect(computeAgentRequestFingerprint(base)).not.toBe(
      computeAgentRequestFingerprint({ ...base, codeApprovalMode: 'acceptEdits' }),
    );
    expect(computeAgentRequestFingerprint(base)).not.toBe(
      computeAgentRequestFingerprint({ ...base, codeApprovalMode: null }),
    );
    expect(computeAgentRequestFingerprint(base)).not.toBe(
      computeAgentRequestFingerprint({ ...base, codeEnvironmentMode: 'without_attached' }),
    );
    expect(computeAgentRequestFingerprint(base)).not.toBe(
      computeAgentRequestFingerprint({
        ...base,
        codeWorkspaces: [{ environmentId: 'env-a', workspaceId: 'project-a' }],
      }),
    );
    expect(
      computeAgentRequestFingerprint({
        ...base,
        codeWorkspaces: [{ environmentId: 'env-a', workspaceId: 'project-a' }],
      }),
    ).not.toBe(
      computeAgentRequestFingerprint({
        ...base,
        codeWorkspaces: [{ environmentId: 'env-a', workspaceId: 'project-b' }],
      }),
    );
  });

  it('keeps a legacy-compatible digest while the current digest pins code environments', () => {
    const base = { endpoint: 'agents', agent_id: 'agent-1' };
    const withWorkspace = {
      ...base,
      codeWorkspaces: [{ environmentId: 'env-a', workspaceId: 'project-a' }],
    };
    const withAttachedWorkspace = { ...withWorkspace, codeEnvironmentMode: 'attached' as const };

    expect(computeLegacyAgentRequestFingerprint(base)).not.toBe(
      computeLegacyAgentRequestFingerprint(withAttachedWorkspace),
    );
    expect(computeLegacyAgentRequestFingerprint(withWorkspace)).toBe(
      computeLegacyAgentRequestFingerprint(withAttachedWorkspace),
    );
    expect(computeAgentRequestFingerprint(base)).not.toBe(
      computeAgentRequestFingerprint(withAttachedWorkspace),
    );
  });

  it('differs when promptPrefix changes (ephemeral instructions)', () => {
    const base = { endpoint: 'agents', promptPrefix: 'be terse' };
    expect(computeAgentRequestFingerprint(base)).not.toBe(
      computeAgentRequestFingerprint({ ...base, promptPrefix: 'be verbose' }),
    );
    // null vs absent are treated the same
    expect(computeAgentRequestFingerprint({ endpoint: 'agents' })).toBe(
      computeAgentRequestFingerprint({ endpoint: 'agents', promptPrefix: null }),
    );
  });

  it('normalizes ephemeralAgent so key/array order does not matter', () => {
    const x = computeAgentRequestFingerprint({
      endpoint: 'agents',
      ephemeralAgent: { mcp: ['b', 'a'], execute_code: true },
    });
    const y = computeAgentRequestFingerprint({
      endpoint: 'agents',
      ephemeralAgent: { execute_code: true, mcp: ['a', 'b'] },
    });
    expect(x).toBe(y);
  });

  it('distinguishes a different ephemeral capability set (the swap it guards against)', () => {
    const a = computeAgentRequestFingerprint({
      endpoint: 'agents',
      ephemeralAgent: { execute_code: true },
    });
    const b = computeAgentRequestFingerprint({
      endpoint: 'agents',
      ephemeralAgent: { execute_code: false, mcp: ['evil'] },
    });
    expect(a).not.toBe(b);
  });
});

describe('pickResumeContext / applyResumeContext', () => {
  it('picks only the graph-determining fields (incl. addedConvo + timezone), dropping unrelated keys', () => {
    const ctx = pickResumeContext({
      endpoint: 'agents',
      agent_id: 'a1',
      model: 'gpt',
      promptPrefix: 'be terse',
      ephemeralAgent: { execute_code: true },
      addedConvo: { agent_id: 'secondary' },
      // Feeds temporal prompt vars; must round-trip so resume compiles the same prompt.
      timezone: 'America/New_York',
      // Graph-determining: skill allowed-tools union into the tool set.
      manualSkills: ['code-reviewer'],
      // Graph-determining: feeds the ephemeral agent id / checkpoint namespace (#14253).
      modelLabel: 'My Opus',
      codeApprovalMode: 'acceptEdits',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ environmentId: 'env-a', workspaceId: 'project-a' }],
      conversationId: 'c',
      decisions: [],
      actionId: 'x',
    });
    expect(ctx).toEqual({
      endpoint: 'agents',
      agent_id: 'a1',
      model: 'gpt',
      promptPrefix: 'be terse',
      ephemeralAgent: { execute_code: true },
      addedConvo: { agent_id: 'secondary' },
      timezone: 'America/New_York',
      manualSkills: ['code-reviewer'],
      modelLabel: 'My Opus',
      codeApprovalMode: 'acceptEdits',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ environmentId: 'env-a', workspaceId: 'project-a' }],
    });
  });

  it('pins code approval mode across resume and removes a forged upgrade', () => {
    const restored: Record<string, unknown> = {
      conversationId: 'c',
      codeApprovalMode: 'acceptEdits',
    };
    applyResumeContext(restored, { endpoint: 'agents', codeApprovalMode: 'ask' });
    expect(restored.codeApprovalMode).toBe('ask');

    const injected: Record<string, unknown> = {
      conversationId: 'c',
      codeApprovalMode: 'acceptEdits',
    };
    applyResumeContext(injected, { endpoint: 'agents' });
    expect('codeApprovalMode' in injected).toBe(false);
  });

  it('pins the attached workspace across resume and removes a forged selection', () => {
    const restored: Record<string, unknown> = {
      conversationId: 'c',
      codeWorkspaces: [{ environmentId: 'env-a', workspaceId: 'project-b' }],
    };
    applyResumeContext(restored, {
      endpoint: 'agents',
      codeWorkspaces: [{ environmentId: 'env-a', workspaceId: 'project-a' }],
    });
    expect(restored.codeWorkspaces).toEqual([{ environmentId: 'env-a', workspaceId: 'project-a' }]);

    const injected: Record<string, unknown> = {
      conversationId: 'c',
      codeWorkspaces: [{ environmentId: 'env-a', workspaceId: 'project-b' }],
    };
    applyResumeContext(injected, { endpoint: 'agents' });
    expect('codeWorkspaces' in injected).toBe(false);
  });

  it('pins the code-environment decision across resume and removes a forged mode', () => {
    const restored: Record<string, unknown> = {
      conversationId: 'c',
      codeEnvironmentMode: 'attached',
    };
    applyResumeContext(restored, {
      endpoint: 'agents',
      codeEnvironmentMode: 'without_attached',
    });
    expect(restored.codeEnvironmentMode).toBe('without_attached');

    const injected: Record<string, unknown> = {
      conversationId: 'c',
      codeEnvironmentMode: 'attached',
    };
    applyResumeContext(injected, { endpoint: 'agents' });
    expect('codeEnvironmentMode' in injected).toBe(false);
  });

  it('replays a dropped modelLabel so the ephemeral agent id stays stable (#14253)', () => {
    // Resume/reload case: the resolved llmConfig stripped modelLabel; the server restores
    // the original top-level value so parseCompactConvo re-derives the same sender/id.
    const restored: Record<string, unknown> = { conversationId: 'c', actionId: 'x' };
    applyResumeContext(restored, { endpoint: 'my-custom-endpoint', modelLabel: 'My Opus' });
    expect(restored.modelLabel).toBe('My Opus');
    // A paused turn with no modelLabel can't be made to inject one.
    const injected: Record<string, unknown> = { conversationId: 'c', modelLabel: 'Spoofed' };
    applyResumeContext(injected, { endpoint: 'my-custom-endpoint' });
    expect('modelLabel' in injected).toBe(false);
  });

  it('replays a dropped manualSkills and drops a client-injected one', () => {
    // Reload case: the resume client lost manualSkills; the server restores it.
    const restored: Record<string, unknown> = { conversationId: 'c', actionId: 'x' };
    applyResumeContext(restored, { endpoint: 'agents', manualSkills: ['code-reviewer'] });
    expect(restored.manualSkills).toEqual(['code-reviewer']);
    // Security: a paused turn with no manual skill can't be made to inject one.
    const injected: Record<string, unknown> = { conversationId: 'c', manualSkills: ['evil-skill'] };
    applyResumeContext(injected, { endpoint: 'agents', agent_id: 'a1' });
    expect('manualSkills' in injected).toBe(false);
  });

  it('omits absent (undefined) fields but keeps explicit null', () => {
    const ctx = pickResumeContext({ endpoint: 'agents', ephemeralAgent: null });
    expect(ctx).toEqual({ endpoint: 'agents', ephemeralAgent: null });
    expect('agent_id' in ctx).toBe(false);
  });

  it('replays the persisted context onto a body, overwriting what the client sent', () => {
    // The reload case: the client lost ephemeralAgent (null); the server restores it.
    const body: Record<string, unknown> = {
      conversationId: 'c',
      actionId: 'x',
      ephemeralAgent: null,
      promptPrefix: 'tampered',
    };
    applyResumeContext(body, {
      endpoint: 'agents',
      ephemeralAgent: { execute_code: true, mcp: ['srv'] },
      promptPrefix: 'original',
    });
    expect(body.ephemeralAgent).toEqual({ execute_code: true, mcp: ['srv'] });
    expect(body.promptPrefix).toBe('original');
    expect(body.endpoint).toBe('agents');
    // Non-context fields are untouched.
    expect(body.conversationId).toBe('c');
    expect(body.actionId).toBe('x');
  });

  it('drops graph-determining fields the client sent that the persisted context lacks', () => {
    // Security: the paused turn carried no addedConvo/spec, so a crafted resume must not
    // be able to inject them (addedConvo isn't covered by the fingerprint). Any
    // RESUME_CONTEXT_KEY absent from the persisted context is cleared from the body.
    const body: Record<string, unknown> = {
      conversationId: 'c',
      actionId: 'x',
      addedConvo: { agent_id: 'injected-secondary' },
      spec: 'injected-spec',
    };
    applyResumeContext(body, { endpoint: 'agents', agent_id: 'a1' });
    // Persisted keys are restored...
    expect(body.endpoint).toBe('agents');
    expect(body.agent_id).toBe('a1');
    // ...and client-injected graph-determining fields absent from the context are gone.
    expect('addedConvo' in body).toBe(false);
    expect('spec' in body).toBe(false);
    // Non-context fields are untouched.
    expect(body.conversationId).toBe('c');
    expect(body.actionId).toBe('x');
  });

  it('is a no-op for a null/undefined context', () => {
    const body: Record<string, unknown> = { ephemeralAgent: null };
    applyResumeContext(body, undefined);
    expect(body.ephemeralAgent).toBeNull();
  });

  it('round-trips through buildPendingAction so replay restores the original body', () => {
    const original = {
      endpoint: 'agents',
      ephemeralAgent: { execute_code: true },
      promptPrefix: 'p',
    };
    const action = buildPendingAction(
      { type: 'ask_user_question', question: { question: 'q' } } as Agents.HumanInterruptPayload,
      { streamId: 's', resumeContext: pickResumeContext(original) },
    );
    const reloadedBody: Record<string, unknown> = { ephemeralAgent: null };
    applyResumeContext(reloadedBody, action.resumeContext);
    expect(reloadedBody.ephemeralAgent).toEqual({ execute_code: true });
    expect(reloadedBody.promptPrefix).toBe('p');
  });
});

describe('applyResumeModelParameters', () => {
  it('replays generation params without replacing routing or resume identity fields (#14946)', () => {
    const body: Record<string, unknown> = {
      conversationId: 'conversation-1',
      generationCreatedAt: 123,
      actionId: 'action-1',
      endpoint: 'agents',
      endpointType: 'google',
      agent_id: 'agent-1',
      model: 'gemini-3.7-flash',
      temperature: 1,
    };

    applyResumeModelParameters(body, {
      conversationId: 'provider-conversation',
      generationCreatedAt: 999,
      actionId: 'provider-action',
      endpoint: 'aiplatform.eu.rep.googleapis.com',
      endpointType: 'custom',
      agent_id: 'provider-agent',
      model: 'provider-model',
      temperature: 0.2,
      maxOutputTokens: 2048,
    });

    expect(body).toEqual({
      conversationId: 'conversation-1',
      generationCreatedAt: 123,
      actionId: 'action-1',
      endpoint: 'agents',
      endpointType: 'google',
      agent_id: 'agent-1',
      model: 'gemini-3.7-flash',
      temperature: 0.2,
      maxOutputTokens: 2048,
    });
  });

  it('is a no-op for invalid captured parameters', () => {
    const body: Record<string, unknown> = { endpoint: 'agents' };
    applyResumeModelParameters(body, undefined);
    applyResumeModelParameters(body, ['aiplatform.eu.rep.googleapis.com']);
    expect(body).toEqual({ endpoint: 'agents' });
  });
});

describe('exemptAskUserQuestionFromApproval', () => {
  const NAME = 'ask_user_question';
  it('adds the tool to allow when the admin did not mention it', () => {
    expect(exemptAskUserQuestionFromApproval({ enabled: true }, NAME)?.allow).toEqual([NAME]);
    expect(
      exemptAskUserQuestionFromApproval({ enabled: true, allow: ['calculator'] }, NAME)?.allow,
    ).toEqual(['calculator', NAME]);
  });
  it('respects explicit admin entries in any list', () => {
    const asked = { enabled: true, ask: [NAME] };
    expect(exemptAskUserQuestionFromApproval(asked, NAME)).toBe(asked);
    const denied = { enabled: true, deny: [NAME] };
    expect(exemptAskUserQuestionFromApproval(denied, NAME)).toBe(denied);
  });
  it('passes undefined through', () => {
    expect(exemptAskUserQuestionFromApproval(undefined, NAME)).toBeUndefined();
  });
});

describe('healToolApprovalPolicy', () => {
  const aliases = [
    { name: 'delete_thing_mcp_acme', aliasName: 'acme_delete_thing_mcp_acme' },
    { name: 'search_mcp_acme', aliasName: 'acme_search_mcp_acme' },
  ];

  it('appends current names to lists whose patterns match only the legacy spelling', () => {
    /** Admin YAML written against upstream naming must keep applying — a
     *  non-matching deny fails OPEN. */
    const healed = healToolApprovalPolicy(
      { enabled: true, deny: ['acme_delete_*'], ask: ['acme_search_mcp_acme'] },
      aliases,
    );

    expect(healed?.deny).toEqual(['acme_delete_*', 'delete_thing_mcp_acme']);
    expect(healed?.ask).toEqual(['acme_search_mcp_acme', 'search_mcp_acme']);
  });

  it('heals list-level so allow semantics are preserved, not tightened', () => {
    const healed = healToolApprovalPolicy({ enabled: true, allow: ['acme_search_*'] }, aliases);

    expect(healed?.allow).toEqual(['acme_search_*', 'search_mcp_acme']);
  });

  it('skips names the list already matches and leaves non-matching lists untouched', () => {
    const healed = healToolApprovalPolicy(
      { enabled: true, deny: ['*_mcp_acme'], allow: ['unrelated_tool'] },
      aliases,
    );

    expect(healed?.deny).toEqual(['*_mcp_acme']);
    expect(healed?.allow).toEqual(['unrelated_tool']);
  });

  it('passes through without aliases or policy', () => {
    expect(healToolApprovalPolicy(undefined, aliases)).toBeUndefined();
    const policy: TToolApprovalPolicy = { enabled: true, deny: ['x'] };
    expect(healToolApprovalPolicy(policy, [])).toBe(policy);
  });
});

describe('healToolApprovalPolicy reverse direction', () => {
  it('appends a legacy-named instance when the pattern targets the current catalog name', () => {
    /** An unedited agent retains the pre-strip instance name — a deny written
     *  against the current catalog name must still reach it. */
    const aliases = [{ name: 'acme_search_mcp_acme', aliasName: 'search_mcp_acme' }];
    const healed = healToolApprovalPolicy(
      { enabled: true, mode: 'bypass', deny: ['search_mcp_acme'] },
      aliases,
    );

    expect(healed?.deny).toEqual(['search_mcp_acme', 'acme_search_mcp_acme']);
  });
});

describe('collectAliasMatcherNames', () => {
  const aliases = [
    { name: 'search_mcp_acme', aliasName: 'acme_search_mcp_acme' },
    { name: 'acme_list_mcp_acme', aliasName: 'list_mcp_acme' },
  ];

  it('returns names whose alias matches the regex while the name does not', () => {
    expect(collectAliasMatcherNames('^acme_search_mcp_acme$', aliases)).toEqual([
      'search_mcp_acme',
    ]);
    expect(collectAliasMatcherNames('^list_mcp_acme$', aliases)).toEqual(['acme_list_mcp_acme']);
  });

  it('skips names the matcher already matches and invalid patterns', () => {
    expect(collectAliasMatcherNames('_mcp_acme$', aliases)).toEqual([]);
    expect(collectAliasMatcherNames('(unclosed', aliases)).toEqual([]);
    expect(collectAliasMatcherNames(undefined, aliases)).toEqual([]);
  });

  it('builds an anchored exact-name pattern with escaped names', () => {
    const pattern = buildAliasMatcherPattern(['a.b_mcp_acme', 'c_mcp_acme']);
    const regex = new RegExp(pattern);
    expect(regex.test('a.b_mcp_acme')).toBe(true);
    expect(regex.test('axb_mcp_acme')).toBe(false);
    expect(regex.test('c_mcp_acme')).toBe(true);
    expect(regex.test('xc_mcp_acme')).toBe(false);
  });
});
