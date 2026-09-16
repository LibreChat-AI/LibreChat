import {
  paramDefinitionSchema,
  agentsEndpointSchema,
  azureEndpointSchema,
  endpointSchema,
  RetentionMode,
  configSchema,
  interfaceSchema,
  fileStorageSchema,
  fileStrategiesSchema,
  SKILL_SYNC_MAX_INTERVAL_MINUTES,
  summarizationTriggerSchema,
  summarizationConfigSchema,
  retainRecentConfigSchema,
  MAX_SUBAGENTS,
  MAX_SUBAGENTS_CEILING,
  setMaxSubagents,
  traceViewerDefaults,
  resolveTraceViewerConfig,
} from '../src/config';
import {
  tModelSpecPresetSchema,
  EModelEndpoint,
  ReasoningParameterFormat,
  ReasoningResponseKey,
} from '../src/schemas';
import { specsConfigSchema, materializeModelSpecEndpoints } from '../src/models';
import { FileSources } from '../src/types/files';

describe('paramDefinitionSchema', () => {
  it('accepts a minimal definition with only key', () => {
    const result = paramDefinitionSchema.safeParse({ key: 'temperature' });
    expect(result.success).toBe(true);
  });

  it('accepts a full definition with all fields', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'temperature',
      type: 'number',
      component: 'slider',
      default: 0.7,
      label: 'Temperature',
      range: { min: 0, max: 2, step: 0.01 },
      columns: 2,
      columnSpan: 1,
      includeInput: true,
      descriptionSide: 'right',
    });
    expect(result.success).toBe(true);
  });

  /**
   * The shared `SettingRange` exposes it, so a configured sentinel range would
   * otherwise reach the UI with its positive floor silently dropped.
   */
  it('preserves a configured positiveMin on the range', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'thinkingBudget',
      type: 'number',
      component: 'slider',
      range: { min: -1, max: 32768, step: 1, positiveMin: 128 },
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.range).toEqual({
      min: -1,
      max: 32768,
      step: 1,
      positiveMin: 128,
    });
  });

  /** The floor would admit nothing but the sentinel while the clamp maps every
   *  non-negative input onto a maximum the generated schema then rejects. */
  it('rejects a positiveMin above the range maximum', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'thinkingBudget',
      type: 'number',
      component: 'slider',
      range: { min: -1, max: 100, positiveMin: 200 },
    });

    expect(result.success).toBe(false);
  });

  it('rejects columns > 4', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'test',
      columns: 5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects columns < 1', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'test',
      columns: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer columns', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'test',
      columns: 2.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer columnSpan', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'test',
      columnSpan: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative minTags', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'test',
      minTags: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid descriptionSide', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'test',
      descriptionSide: 'diagonal',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid type enum value', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'test',
      type: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid component enum value', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'test',
      component: 'wheel',
    });
    expect(result.success).toBe(false);
  });

  it('allows type and component to be omitted (merged from defaults at runtime)', () => {
    const result = paramDefinitionSchema.safeParse({
      key: 'temperature',
      range: { min: 0, max: 2, step: 0.01 },
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('type');
    expect(result.data).not.toHaveProperty('component');
  });
});

describe('tModelSpecPresetSchema', () => {
  it('strips system/DB fields from preset', () => {
    const result = tModelSpecPresetSchema.safeParse({
      conversationId: 'conv-123',
      presetId: 'preset-456',
      title: 'My Preset',
      defaultPreset: true,
      order: 3,
      isArchived: true,
      user: 'user123',
      messages: ['msg1'],
      tags: ['tag1'],
      file_ids: ['file1'],
      expiredAt: '2026-12-31',
      parentMessageId: 'parent1',
      model: 'gpt-4o',
      endpoint: EModelEndpoint.openAI,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('conversationId');
      expect(result.data).not.toHaveProperty('presetId');
      expect(result.data).not.toHaveProperty('title');
      expect(result.data).not.toHaveProperty('defaultPreset');
      expect(result.data).not.toHaveProperty('order');
      expect(result.data).not.toHaveProperty('isArchived');
      expect(result.data).not.toHaveProperty('user');
      expect(result.data).not.toHaveProperty('messages');
      expect(result.data).not.toHaveProperty('tags');
      expect(result.data).not.toHaveProperty('file_ids');
      expect(result.data).not.toHaveProperty('expiredAt');
      expect(result.data).not.toHaveProperty('parentMessageId');
      expect(result.data).toHaveProperty('model', 'gpt-4o');
    }
  });

  it('strips deprecated fields', () => {
    const result = tModelSpecPresetSchema.safeParse({
      resendImages: true,
      chatGptLabel: 'old-label',
      model: 'gpt-4o',
      endpoint: EModelEndpoint.openAI,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('resendImages');
      expect(result.data).not.toHaveProperty('chatGptLabel');
    }
  });

  it('strips client-managed and preset-override fields', () => {
    const result = tModelSpecPresetSchema.safeParse({
      spec: 'some-spec',
      presetOverride: { model: 'other' },
      model: 'gpt-4o',
      endpoint: EModelEndpoint.openAI,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('spec');
      expect(result.data).not.toHaveProperty('presetOverride');
    }
  });

  it('preserves admin-configurable display fields (greeting, iconURL)', () => {
    const result = tModelSpecPresetSchema.safeParse({
      greeting: 'Hello!',
      iconURL: 'https://example.com/icon.png',
      model: 'gpt-4o',
      endpoint: EModelEndpoint.openAI,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('greeting', 'Hello!');
      expect(result.data).toHaveProperty('iconURL', 'https://example.com/icon.png');
    }
  });

  it('preserves valid preset fields', () => {
    const result = tModelSpecPresetSchema.safeParse({
      model: 'gpt-4o',
      endpoint: EModelEndpoint.openAI,
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 4096,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('gpt-4o');
      expect(result.data.temperature).toBe(0.7);
      expect(result.data.topP).toBe(0.9);
      expect(result.data.maxOutputTokens).toBe(4096);
    }
  });
});

describe('endpointSchema deprecated fields', () => {
  const validEndpoint = {
    name: 'CustomEndpoint',
    apiKey: 'test-key',
    baseURL: 'https://api.example.com',
    models: { default: ['model-1'] },
  };

  it('silently strips deprecated summarize field', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      summarize: true,
      summaryModel: 'gpt-4o',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('summarize');
      expect(result.data).not.toHaveProperty('summaryModel');
    }
  });

  it('silently strips deprecated customOrder field', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      customOrder: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('customOrder');
    }
  });
});

describe('endpointSchema addParams validation', () => {
  const validEndpoint = {
    name: 'CustomEndpoint',
    apiKey: 'test-key',
    baseURL: 'https://api.example.com',
    models: { default: ['model-1'] },
  };
  const nestedAddParams = {
    provider: {
      only: ['z-ai'],
      quantizations: ['int4'],
    },
  };

  it('accepts nested addParams objects and arrays', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      addParams: nestedAddParams,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.addParams).toEqual(nestedAddParams);
    }
  });

  it('keeps configSchema validation intact with nested custom addParams', () => {
    const result = configSchema.safeParse({
      version: '1.0.0',
      endpoints: {
        custom: [
          {
            ...validEndpoint,
            addParams: nestedAddParams,
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts boolean web_search in addParams', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      addParams: {
        provider: {
          only: ['z-ai'],
        },
        web_search: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts scalar addParams values', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      addParams: {
        model: 'custom-model',
        retries: 2,
        metadata: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts custom reasoning format config', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      customParams: {
        reasoningFormat: ReasoningParameterFormat.reasoningObject,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customParams?.reasoningFormat).toBe(
        ReasoningParameterFormat.reasoningObject,
      );
    }
  });

  it('rejects invalid custom reasoning format config', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      customParams: {
        reasoningFormat: 'provider_magic',
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts custom reasoning response key config', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      customParams: {
        reasoningKey: ReasoningResponseKey.reasoning,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customParams?.reasoningKey).toBe(ReasoningResponseKey.reasoning);
    }
  });

  it('rejects invalid custom reasoning response key config', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      customParams: {
        reasoningKey: 'reasoning_text',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects non-boolean web_search objects in addParams', () => {
    const result = endpointSchema.safeParse({
      ...validEndpoint,
      addParams: {
        provider: {
          only: ['z-ai'],
        },
        web_search: {
          enabled: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects configSchema entries with non-boolean web_search objects in custom addParams', () => {
    const result = configSchema.safeParse({
      version: '1.0.0',
      endpoints: {
        custom: [
          {
            ...validEndpoint,
            addParams: {
              provider: {
                only: ['z-ai'],
              },
              web_search: {
                enabled: true,
              },
            },
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('agentsEndpointSchema', () => {
  it('defaults and bounds Code API upload recovery controls', () => {
    expect(agentsEndpointSchema.parse({}).codeApiUploadConcurrency).toBe(3);
    expect(
      agentsEndpointSchema.parse({ codeApiUploadConcurrency: 8 }).codeApiUploadConcurrency,
    ).toBe(8);
    expect(agentsEndpointSchema.safeParse({ codeApiUploadConcurrency: 0 }).success).toBe(false);
    expect(agentsEndpointSchema.safeParse({ codeApiUploadConcurrency: 101 }).success).toBe(false);
    expect(agentsEndpointSchema.parse({}).codeApiMaxRetryWaitMs).toBe(20_000);
    expect(
      agentsEndpointSchema.parse({ codeApiMaxRetryWaitMs: 60_000 }).codeApiMaxRetryWaitMs,
    ).toBe(60_000);
    expect(agentsEndpointSchema.safeParse({ codeApiMaxRetryWaitMs: -1 }).success).toBe(false);
    expect(agentsEndpointSchema.safeParse({ codeApiMaxRetryWaitMs: 300_001 }).success).toBe(false);
  });

  it('accepts a non-empty stateful code environment allowlist', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: { allowedEnvironments: ['user', 'agent-user'] },
    });

    expect(result.success).toBe(true);
  });

  it.each([0, 5, 1000])('accepts a personal worker ceiling of %i', (maxPerUser) => {
    const principalWorkers = { enabled: true, maxPerUser };
    const result = agentsEndpointSchema.parse({
      statefulCodeSessions: { allowedEnvironments: ['user'], principalWorkers },
    });
    expect(result.statefulCodeSessions?.principalWorkers).toEqual(principalWorkers);
  });

  it.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid personal worker ceiling %s',
    (maxPerUser) => {
      expect(
        agentsEndpointSchema.safeParse({
          statefulCodeSessions: {
            allowedEnvironments: ['user'],
            principalWorkers: { maxPerUser },
          },
        }).success,
      ).toBe(false);
    },
  );

  it('accepts uniquely named execution environments with exactly one default', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['conversation'],
        environments: [
          {
            id: 'managed',
            name: 'Managed',
            type: 'managed',
            baseURL: 'https://code.example.com/v1',
            default: true,
          },
          {
            id: 'attached-vm',
            name: 'Attached VM',
            type: 'attached',
            baseURL: 'https://bridge.example.com/v1',
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it.each([
    'ftp://code.example.com/v1',
    'https://code.example.com/v1?',
    'https://code.example.com/v1?token=secret',
    'https://code.example.com/v1#',
    'https://code.example.com/v1#fragment',
  ])('rejects a non-base execution environment URL: %s', (baseURL) => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['conversation'],
        environments: [
          {
            id: 'attached-vm',
            name: 'Attached VM',
            type: 'attached',
            baseURL,
            default: true,
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('normalizes surrounding whitespace in an execution environment URL', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['conversation'],
        environments: [
          {
            id: 'attached-vm',
            name: 'Attached VM',
            type: 'attached',
            baseURL: '  https://bridge.example.com/v1/  ',
            default: true,
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.statefulCodeSessions?.environments?.[0]?.baseURL).toBe(
        'https://bridge.example.com/v1/',
      );
    }
  });

  it('accepts deployment-owned pairing configuration for an attached environment', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['conversation'],
        environments: [
          {
            id: 'attached-vm',
            name: 'Attached VM',
            type: 'attached',
            baseURL: 'https://bridge.example.com/v1',
            default: true,
            owner: 'deployment',
            pairing: {
              workerId: 'vm-1',
              tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.statefulCodeSessions?.environments?.[0]).toMatchObject({
        owner: 'deployment',
        pairing: {
          workerId: 'vm-1',
          tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
        },
      });
    }
  });

  it('accepts a principal-owned environment without deployment pairing metadata', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['user'],
        environments: [
          {
            id: 'personal-vm',
            name: 'Personal VM',
            type: 'attached',
            baseURL: 'https://bridge.example.com/v1',
            owner: 'principal',
            default: true,
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a principal-worker control plane without a singleton worker', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['user'],
        environments: [
          {
            id: 'personal-code-control-plane',
            name: 'Personal Code',
            type: 'attached',
            baseURL: 'https://bridge.example.com/v1',
            pairing: {
              allowPrincipalWorkers: true,
              tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a pairing-only control plane as the execution default', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['user'],
        environments: [
          {
            id: 'personal-code-control-plane',
            name: 'Personal Code',
            type: 'attached',
            baseURL: 'https://bridge.example.com/v1',
            default: true,
            pairing: {
              allowPrincipalWorkers: true,
              tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects conflicting direct and pairing worker routes', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['user'],
        environments: [
          {
            id: 'attached-vm',
            name: 'Attached VM',
            type: 'attached',
            baseURL: 'https://bridge.example.com/v1',
            default: true,
            workerId: 'direct-worker',
            pairing: {
              workerId: 'paired-worker',
              tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects pairing metadata on a principal-owned environment', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['user'],
        environments: [
          {
            id: 'personal-vm',
            name: 'Personal VM',
            type: 'attached',
            baseURL: 'https://bridge.example.com/v1',
            owner: 'principal',
            pairing: {
              workerId: 'vm-1',
              tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects pairing configuration without a singleton or principal workers', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['user'],
        environments: [
          {
            id: 'invalid-control-plane',
            name: 'Invalid',
            type: 'attached',
            baseURL: 'https://bridge.example.com/v1',
            default: true,
            pairing: { tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN' },
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects pairing configuration for a managed environment', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['conversation'],
        environments: [
          {
            id: 'managed',
            name: 'Managed',
            type: 'managed',
            baseURL: 'https://code.example.com/v1',
            default: true,
            pairing: {
              workerId: 'vm-1',
              tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects pairing over insecure non-loopback transport', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['conversation'],
        environments: [
          {
            id: 'attached-vm',
            name: 'Attached VM',
            type: 'attached',
            baseURL: 'http://bridge.example.com/v1',
            default: true,
            pairing: {
              workerId: 'vm-1',
              tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('allows loopback HTTP pairing for local development', () => {
    const result = agentsEndpointSchema.safeParse({
      statefulCodeSessions: {
        allowedEnvironments: ['conversation'],
        environments: [
          {
            id: 'attached-vm',
            name: 'Attached VM',
            type: 'attached',
            baseURL: 'http://127.0.0.1:23112/v1',
            default: true,
            pairing: {
              workerId: 'vm-1',
              tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects ambiguous execution environment routing', () => {
    const environment = {
      id: 'attached-vm',
      name: 'Attached VM',
      type: 'attached',
      baseURL: 'https://bridge.example.com/v1',
    } as const;
    const parse = (environments: unknown[]) =>
      agentsEndpointSchema.safeParse({
        statefulCodeSessions: {
          allowedEnvironments: ['conversation'],
          environments,
        },
      });

    expect(parse([environment]).success).toBe(false);
    expect(parse([{ ...environment, default: true }, { ...environment }]).success).toBe(false);
  });

  it('defaults maxSubagents to MAX_SUBAGENTS and validates its bounds', () => {
    const omitted = agentsEndpointSchema.safeParse({});
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.maxSubagents).toBe(MAX_SUBAGENTS);
    }

    const raised = agentsEndpointSchema.safeParse({ maxSubagents: MAX_SUBAGENTS + 10 });
    expect(raised.success).toBe(true);
    if (raised.success) {
      expect(raised.data.maxSubagents).toBe(MAX_SUBAGENTS + 10);
    }

    expect(agentsEndpointSchema.safeParse({ maxSubagents: 0 }).success).toBe(false);
    expect(agentsEndpointSchema.safeParse({ maxSubagents: 2.5 }).success).toBe(false);
    expect(
      agentsEndpointSchema.safeParse({ maxSubagents: MAX_SUBAGENTS_CEILING + 1 }).success,
    ).toBe(false);
  });

  it('rejects empty or unknown stateful code environment allowlists', () => {
    expect(
      agentsEndpointSchema.safeParse({
        statefulCodeSessions: { allowedEnvironments: [] },
      }).success,
    ).toBe(false);
    expect(
      agentsEndpointSchema.safeParse({
        statefulCodeSessions: { allowedEnvironments: ['agent'] },
      }).success,
    ).toBe(false);
  });

  it('does not accept baseURL', () => {
    const result = agentsEndpointSchema.safeParse({
      baseURL: 'https://example.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('baseURL');
    }
  });

  it('allows explicitly disabled remote OIDC auth without issuer', () => {
    const result = agentsEndpointSchema.safeParse({
      remoteApi: {
        auth: {
          oidc: {
            enabled: false,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('requires a valid issuer when remote OIDC auth is enabled', () => {
    const missingIssuer = agentsEndpointSchema.safeParse({
      remoteApi: {
        auth: {
          oidc: {
            enabled: true,
            audience: 'remote-agent-api',
          },
        },
      },
    });
    const invalidIssuer = agentsEndpointSchema.safeParse({
      remoteApi: {
        auth: {
          oidc: {
            enabled: true,
            issuer: 'my-realm',
            audience: 'remote-agent-api',
          },
        },
      },
    });

    expect(missingIssuer.success).toBe(false);
    expect(invalidIssuer.success).toBe(false);
  });

  it('requires an audience when remote OIDC auth is enabled', () => {
    const result = agentsEndpointSchema.safeParse({
      remoteApi: {
        auth: {
          oidc: {
            enabled: true,
            issuer: 'https://auth.example.com',
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('requires HTTPS remote OIDC issuer and JWKS URLs outside localhost', () => {
    const insecureIssuer = agentsEndpointSchema.safeParse({
      remoteApi: {
        auth: {
          oidc: {
            enabled: true,
            issuer: 'http://auth.example.com',
            audience: 'remote-agent-api',
          },
        },
      },
    });
    const insecureJwksUri = agentsEndpointSchema.safeParse({
      remoteApi: {
        auth: {
          oidc: {
            enabled: true,
            issuer: 'https://auth.example.com',
            audience: 'remote-agent-api',
            jwksUri: 'http://auth.example.com/jwks',
          },
        },
      },
    });

    expect(insecureIssuer.success).toBe(false);
    expect(insecureJwksUri.success).toBe(false);
  });

  it('allows localhost HTTP remote OIDC URLs for development', () => {
    const result = agentsEndpointSchema.safeParse({
      remoteApi: {
        auth: {
          oidc: {
            enabled: true,
            issuer: 'http://localhost:8080/realms/test',
            audience: 'remote-agent-api',
            jwksUri: 'http://127.0.0.1:8080/realms/test/protocol/openid-connect/certs',
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('requires space-separated remote OIDC scopes', () => {
    const result = agentsEndpointSchema.safeParse({
      remoteApi: {
        auth: {
          oidc: {
            enabled: true,
            issuer: 'https://auth.example.com',
            audience: 'remote-agent-api',
            scope: 'remote_agent,admin',
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('azureEndpointSchema', () => {
  it('silently strips plugins field', () => {
    const result = azureEndpointSchema.safeParse({
      groups: [
        {
          group: 'test-group',
          apiKey: 'test-key',
          models: { 'gpt-4': true },
        },
      ],
      plugins: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('plugins');
    }
  });

  it('accepts nested addParams in azure groups', () => {
    const result = azureEndpointSchema.safeParse({
      groups: [
        {
          group: 'test-group',
          apiKey: 'test-key',
          models: { 'gpt-4': true },
          addParams: {
            provider: {
              only: ['z-ai'],
            },
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups[0].addParams).toEqual({
        provider: {
          only: ['z-ai'],
        },
      });
    }
  });

  it('accepts boolean web_search in azure addParams', () => {
    const result = azureEndpointSchema.safeParse({
      groups: [
        {
          group: 'test-group',
          apiKey: 'test-key',
          models: { 'gpt-4': true },
          addParams: {
            provider: {
              only: ['z-ai'],
            },
            web_search: false,
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-boolean web_search objects in azure addParams', () => {
    const result = azureEndpointSchema.safeParse({
      groups: [
        {
          group: 'test-group',
          apiKey: 'test-key',
          models: { 'gpt-4': true },
          addParams: {
            provider: {
              only: ['z-ai'],
            },
            web_search: {
              enabled: true,
            },
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('fileStorageSchema', () => {
  const validStrategies = [
    FileSources.local,
    FileSources.firebase,
    FileSources.s3,
    FileSources.azure_blob,
  ];
  const invalidStrategies = [
    FileSources.openai,
    FileSources.azure,
    FileSources.vectordb,
    FileSources.execute_code,
    FileSources.mistral_ocr,
    FileSources.azure_mistral_ocr,
    FileSources.vertexai_mistral_ocr,
    FileSources.text,
    FileSources.document_parser,
  ];

  for (const strategy of validStrategies) {
    it(`accepts storage strategy "${strategy}"`, () => {
      expect(fileStorageSchema.safeParse(strategy).success).toBe(true);
    });
  }

  for (const strategy of invalidStrategies) {
    it(`rejects processing strategy "${strategy}"`, () => {
      expect(fileStorageSchema.safeParse(strategy).success).toBe(false);
    });
  }
});

describe('fileStrategiesSchema', () => {
  it('accepts valid storage strategies for all sub-fields', () => {
    const result = fileStrategiesSchema.safeParse({
      default: FileSources.s3,
      avatar: FileSources.local,
      image: FileSources.firebase,
      document: FileSources.azure_blob,
    });
    expect(result.success).toBe(true);
  });

  it('rejects processing strategies in sub-fields', () => {
    const result = fileStrategiesSchema.safeParse({
      default: FileSources.vectordb,
    });
    expect(result.success).toBe(false);
  });
});

describe('configSchema fileStrategy', () => {
  it('rejects a processing strategy as fileStrategy', () => {
    const result = configSchema.safeParse({ version: '1.3.7', fileStrategy: FileSources.vectordb });
    expect(result.success).toBe(false);
  });

  it('defaults fileStrategy to local when absent', () => {
    const result = configSchema.safeParse({ version: '1.3.7' });
    expect(result.success).toBe(true);
    expect(result.data?.fileStrategy).toBe(FileSources.local);
  });
});

describe('configSchema fileListLimit', () => {
  it('defaults fileListLimit to 100 for existing configurations', () => {
    const result = configSchema.parse({ version: '1.3.7' });
    expect(result.fileListLimit).toBe(100);
  });

  it('accepts a positive integer override', () => {
    const result = configSchema.safeParse({ version: '1.3.7', fileListLimit: 250 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fileListLimit).toBe(250);
    }
  });

  it.each([0, -1, 1.5])('rejects invalid fileListLimit %p', (fileListLimit) => {
    expect(configSchema.safeParse({ version: '1.3.7', fileListLimit }).success).toBe(false);
  });
});

describe('configSchema skillSync', () => {
  it('accepts a GitHub skill sync source with explicit paths and credential key', () => {
    const result = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: true,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'main',
              paths: ['skills', '.'],
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.skillSync?.github?.sources[0]?.paths).toEqual(['skills', '']);
    expect(result.data?.skillSync?.github?.sources[0]?.skillDiscoveryDepth).toBeUndefined();
  });

  it('accepts a GitHub skill sync source with an env-backed token and discovery depth', () => {
    const result = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          sources: [
            {
              id: 'mattpocock-skills',
              owner: 'mattpocock',
              repo: 'skills',
              paths: ['skills'],
              skillDiscoveryDepth: 3,
              token: '${GITHUB_SKILLS_TOKEN}',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.skillSync?.github?.sources[0]?.token).toBe('${GITHUB_SKILLS_TOKEN}');
    expect(result.data?.skillSync?.github?.sources[0]?.skillDiscoveryDepth).toBe(3);
  });

  it('accepts an optional tenantId on a GitHub skill sync source', () => {
    const result = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
              tenantId: 'tenant-a',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.skillSync?.github?.sources[0]?.tenantId).toBe('tenant-a');
  });

  it('rejects the reserved system tenant id on a GitHub skill sync source', () => {
    const result = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
              tenantId: '__SYSTEM__',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects enabled GitHub skill sync without sources', () => {
    const result = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          sources: [],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects GitHub skill sync intervals below five minutes', () => {
    const result = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          intervalMinutes: 4,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects GitHub skill sync intervals above the Node timer limit', () => {
    const result = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          intervalMinutes: SKILL_SYNC_MAX_INTERVAL_MINUTES + 1,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unsafe GitHub skill sync paths and credential keys', () => {
    const result = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              paths: ['../skills'],
              credentialKey: '../token',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects GitHub skill sync sources without credentials or with literal tokens', () => {
    const missingCredential = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              paths: ['skills'],
            },
          ],
        },
      },
    });
    const literalToken = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              paths: ['skills'],
              token: 'github_pat_secret',
            },
          ],
        },
      },
    });
    const duplicateCredentialSources = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
              token: '${GITHUB_SKILLS_TOKEN}',
            },
          ],
        },
      },
    });
    expect(missingCredential.success).toBe(false);
    expect(literalToken.success).toBe(false);
    expect(duplicateCredentialSources.success).toBe(false);
  });

  it('rejects GitHub skill sync discovery depths outside the allowed range', () => {
    const result = configSchema.safeParse({
      version: '1.3.11',
      skillSync: {
        github: {
          enabled: true,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
              skillDiscoveryDepth: 11,
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed GitHub skill sync refs during config validation', () => {
    const invalidRefs = [
      'feature branch',
      'release:2026',
      'bad?ref',
      'bad*ref',
      '[bad]',
      '@{upstream}',
      'main.lock',
    ];

    for (const ref of invalidRefs) {
      const result = configSchema.safeParse({
        version: '1.3.11',
        skillSync: {
          github: {
            enabled: true,
            sources: [
              {
                id: 'librechat-skills',
                owner: 'LibreChat',
                repo: 'skills',
                ref,
                paths: ['skills'],
                credentialKey: 'github-skills-prod',
              },
            ],
          },
        },
      });
      expect(result.success).toBe(false);
    }
  });
});

describe('interfaceSchema', () => {
  it('accepts independent retention periods', () => {
    expect(
      interfaceSchema.parse({
        retentionMode: RetentionMode.ALL,
        temporaryChatRetention: 1,
        generalChatRetention: 2160,
      }),
    ).toMatchObject({
      temporaryChatRetention: 1,
      generalChatRetention: 2160,
    });
    expect(interfaceSchema.parse({})).not.toHaveProperty('generalChatRetention');
  });

  it.each([0, 8761, '2160', null])(
    'rejects invalid general retention: %s',
    (generalChatRetention) => {
      expect(interfaceSchema.safeParse({ generalChatRetention }).success).toBe(false);
    },
  );

  it('silently strips removed legacy fields', () => {
    const result = interfaceSchema.parse({
      endpointsMenu: true,
      sidePanel: true,
      modelSelect: false,
    });
    expect(result).not.toHaveProperty('endpointsMenu');
    expect(result).not.toHaveProperty('sidePanel');
    expect(result.modelSelect).toBe(false);
  });

  it('accepts retainAgentFiles with all-data retention', () => {
    const result = interfaceSchema.parse({
      retentionMode: RetentionMode.ALL,
      retainAgentFiles: true,
    });

    expect(result.retentionMode).toBe(RetentionMode.ALL);
    expect(result.retainAgentFiles).toBe(true);
  });

  it('accepts defaultPinnedTools as a string array', () => {
    const result = interfaceSchema.parse({
      defaultPinnedTools: ['artifacts', 'execute_code', 'mcp'],
    });

    expect(result.defaultPinnedTools).toEqual(['artifacts', 'execute_code', 'mcp']);
  });

  it('leaves defaultPinnedTools undefined when not provided', () => {
    const result = interfaceSchema.parse({ modelSelect: true });

    expect(result.defaultPinnedTools).toBeUndefined();
  });
});

describe('summarizationTriggerSchema', () => {
  it.each([
    ['token_ratio', 0.8],
    ['remaining_tokens', 500],
    ['messages_to_refine', 4],
  ] as const)('accepts documented trigger type "%s" with a sensible value', (type, value) => {
    const result = summarizationTriggerSchema.safeParse({ type, value });
    expect(result.success).toBe(true);
  });

  it('rejects the legacy/typoed "token_count" trigger type', () => {
    const result = summarizationTriggerSchema.safeParse({
      type: 'token_count',
      value: 8000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown trigger types', () => {
    const result = summarizationTriggerSchema.safeParse({
      type: 'never_heard_of_it',
      value: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative values on any trigger type', () => {
    expect(summarizationTriggerSchema.safeParse({ type: 'token_ratio', value: -0.5 }).success).toBe(
      false,
    );
    expect(
      summarizationTriggerSchema.safeParse({ type: 'remaining_tokens', value: -1 }).success,
    ).toBe(false);
    expect(
      summarizationTriggerSchema.safeParse({ type: 'messages_to_refine', value: -1 }).success,
    ).toBe(false);
  });

  it('rejects zero for count-based triggers where it has no meaningful effect', () => {
    expect(
      summarizationTriggerSchema.safeParse({ type: 'remaining_tokens', value: 0 }).success,
    ).toBe(false);
    expect(
      summarizationTriggerSchema.safeParse({ type: 'messages_to_refine', value: 0 }).success,
    ).toBe(false);
  });

  it('rejects token_ratio values > 1 to catch the "80 meant as 80%" mistake', () => {
    expect(summarizationTriggerSchema.safeParse({ type: 'token_ratio', value: 80 }).success).toBe(
      false,
    );
    expect(summarizationTriggerSchema.safeParse({ type: 'token_ratio', value: 1.01 }).success).toBe(
      false,
    );
  });

  it('accepts token_ratio values at the inclusive 0 and 1 bounds per docs', () => {
    expect(summarizationTriggerSchema.safeParse({ type: 'token_ratio', value: 0 }).success).toBe(
      true,
    );
    expect(summarizationTriggerSchema.safeParse({ type: 'token_ratio', value: 1 }).success).toBe(
      true,
    );
  });

  it('allows remaining_tokens and messages_to_refine values above 1 (token/message counts)', () => {
    expect(
      summarizationTriggerSchema.safeParse({ type: 'remaining_tokens', value: 2000 }).success,
    ).toBe(true);
    expect(
      summarizationTriggerSchema.safeParse({ type: 'messages_to_refine', value: 20 }).success,
    ).toBe(true);
  });

  it('rejects non-finite values (Infinity, NaN) for every trigger type', () => {
    for (const type of ['token_ratio', 'remaining_tokens', 'messages_to_refine'] as const) {
      expect(summarizationTriggerSchema.safeParse({ type, value: Infinity }).success).toBe(false);
      expect(summarizationTriggerSchema.safeParse({ type, value: -Infinity }).success).toBe(false);
      expect(summarizationTriggerSchema.safeParse({ type, value: NaN }).success).toBe(false);
    }
  });

  it('requires integer values for count-based triggers', () => {
    expect(
      summarizationTriggerSchema.safeParse({ type: 'remaining_tokens', value: 500.5 }).success,
    ).toBe(false);
    expect(
      summarizationTriggerSchema.safeParse({ type: 'messages_to_refine', value: 2.5 }).success,
    ).toBe(false);
  });

  it('still allows fractional values for token_ratio', () => {
    expect(summarizationTriggerSchema.safeParse({ type: 'token_ratio', value: 0.8 }).success).toBe(
      true,
    );
  });

  it('parses inside the full summarization config', () => {
    const result = summarizationConfigSchema.safeParse({
      enabled: true,
      trigger: { type: 'token_ratio', value: 0.8 },
    });
    expect(result.success).toBe(true);
  });
});

describe('retainRecentConfigSchema', () => {
  it('accepts turn and token retention limits', () => {
    const result = retainRecentConfigSchema.safeParse({
      turns: 5,
      tokens: 40000,
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid turn and token retention limits', () => {
    expect(retainRecentConfigSchema.safeParse({ turns: -1 }).success).toBe(false);
    expect(retainRecentConfigSchema.safeParse({ turns: 21 }).success).toBe(false);
    expect(retainRecentConfigSchema.safeParse({ tokens: 0 }).success).toBe(false);
  });

  it('parses inside the full summarization config', () => {
    const result = summarizationConfigSchema.safeParse({
      enabled: true,
      retainRecent: { turns: 5, tokens: 40000 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.retainRecent).toEqual({ turns: 5, tokens: 40000 });
    }
  });
});

describe('specsConfigSchema', () => {
  it('accepts an empty list (defaults applied)', () => {
    const result = specsConfigSchema.safeParse({ list: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.list).toEqual([]);
      expect(result.data.enforce).toBe(false);
      expect(result.data.prioritize).toBe(true);
    }
  });

  it('defaults list to [] when omitted', () => {
    const result = specsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.list).toEqual([]);
    }
  });

  it('accepts a populated list', () => {
    const result = specsConfigSchema.safeParse({
      enforce: true,
      list: [
        {
          name: 'spec-1',
          label: 'Spec 1',
          hideBadgeRow: true,
          softDefault: true,
          preset: { endpoint: EModelEndpoint.openAI },
          subagents: { enabled: true, allowSelf: true, agent_ids: ['agent_researcher'] },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.list[0].hideBadgeRow).toBe(true);
      expect(result.data.list[0].softDefault).toBe(true);
      expect(result.data.list[0].subagents).toEqual({
        enabled: true,
        allowSelf: true,
        agent_ids: ['agent_researcher'],
      });
    }
  });

  it('still rejects null list', () => {
    const result = specsConfigSchema.safeParse({ list: null });
    expect(result.success).toBe(false);
  });

  /**
   * The endpoint is inferable from `agent_id`, so config validation must not
   * reject the spec before `materializeModelSpecEndpoints` can fill it in.
   */
  it('accepts an agent spec whose preset omits endpoint', () => {
    const result = specsConfigSchema.safeParse({
      list: [
        {
          name: 'agent-spec',
          label: 'Agent Spec',
          preset: { agent_id: 'agent_abc' },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.list[0].preset.agent_id).toBe('agent_abc');
      expect(result.data.list[0].preset.endpoint).toBeUndefined();
    }
  });

  /** Omission is only legal when inferable — a preset naming no agent still needs the key. */
  it('rejects an endpoint-less preset that names no agent', () => {
    const result = specsConfigSchema.safeParse({
      list: [{ name: 'dead-spec', label: 'Dead Spec', preset: { model: 'gpt-4o' } }],
    });
    expect(result.success).toBe(false);
  });

  /** `endpoint: null` validated before the key became optional; it must keep validating. */
  it('still accepts an explicit null endpoint without an agent', () => {
    const result = specsConfigSchema.safeParse({
      list: [{ name: 'null-spec', label: 'Null Spec', preset: { endpoint: null } }],
    });
    expect(result.success).toBe(true);
  });

  /** Form-backed writers persist untouched fields as `''`, which names no agent. */
  it('rejects an endpoint-less preset whose agent_id is an empty string', () => {
    const result = specsConfigSchema.safeParse({
      list: [{ name: 'empty-agent', label: 'Empty Agent', preset: { agent_id: '' } }],
    });
    expect(result.success).toBe(false);
  });

  /**
   * An explicit `endpoint: null` is a statement, not an omission: such specs
   * validated and stayed inert before inference existed, and must remain so.
   */
  it('does not infer over an explicit null endpoint, even with an agent_id', () => {
    const parsed = specsConfigSchema.parse({
      list: [
        {
          name: 'null-agent-spec',
          label: 'Null Agent Spec',
          preset: { endpoint: null, agent_id: 'agent_abc' },
        },
      ],
    });

    const materialized = materializeModelSpecEndpoints(parsed);

    expect(materialized.list[0].preset.endpoint).toBeNull();
    expect(materialized).toBe(parsed);
  });

  it('materializes the inferred endpoint onto parsed agent specs', () => {
    const parsed = specsConfigSchema.parse({
      list: [
        { name: 'agent-spec', label: 'Agent Spec', preset: { agent_id: 'agent_abc' } },
        {
          name: 'explicit-spec',
          label: 'Explicit Spec',
          preset: { endpoint: EModelEndpoint.openAI, agent_id: 'agent_abc' },
        },
        { name: 'bare-spec', label: 'Bare Spec', preset: { endpoint: null } },
      ],
    });

    const materialized = materializeModelSpecEndpoints(parsed);

    expect(materialized.list[0].preset.endpoint).toBe(EModelEndpoint.agents);
    expect(materialized.list[1].preset.endpoint).toBe(EModelEndpoint.openAI);
    expect(materialized.list[1]).toBe(parsed.list[1]);
    expect(materialized.list[2].preset.endpoint).toBeNull();
  });

  it('returns the same object when every spec already has an endpoint', () => {
    const parsed = specsConfigSchema.parse({
      list: [{ name: 'spec', label: 'Spec', preset: { endpoint: EModelEndpoint.openAI } }],
    });
    expect(materializeModelSpecEndpoints(parsed)).toBe(parsed);
  });

  it('rejects model spec subagent ids above the shared cap', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => `agent_${i}`);
    const result = specsConfigSchema.safeParse({
      list: [
        {
          name: 'spec-1',
          label: 'Spec 1',
          preset: { endpoint: EModelEndpoint.openAI },
          subagents: { enabled: true, agent_ids: oversized },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('validates model spec subagent ids against the configured cap', () => {
    const raised = Array.from({ length: MAX_SUBAGENTS + 5 }, (_, i) => `agent_${i}`);
    setMaxSubagents(MAX_SUBAGENTS + 10);
    const withinRaised = specsConfigSchema.safeParse({
      list: [
        {
          name: 'spec-1',
          label: 'Spec 1',
          preset: { endpoint: EModelEndpoint.openAI },
          subagents: { enabled: true, agent_ids: raised },
        },
      ],
    });
    setMaxSubagents(undefined);
    expect(withinRaised.success).toBe(true);
  });
});

describe('configSchema langfuse', () => {
  it('accepts tenant Langfuse connection config', () => {
    const result = configSchema.safeParse({
      version: '1.3.7',
      langfuse: {
        enabled: true,
        publicKey: 'pk-lf-tenant',
        secretKey: 'sk-lf-tenant',
        destination: 'eu',
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts an explicit tenant Langfuse opt-out', () => {
    const result = configSchema.safeParse({
      version: '1.3.7',
      langfuse: {
        enabled: false,
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts custom Langfuse request headers', () => {
    const result = configSchema.safeParse({
      version: '1.3.7',
      langfuse: {
        enabled: true,
        headers: {
          'CF-Access-Client-Id': 'proxy-client',
          'X-Proxy-Token': '${LANGFUSE_PROXY_TOKEN}',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts trace identity and metadata allowlists', () => {
    const result = configSchema.safeParse({
      version: '1.3.7',
      langfuse: {
        trace: {
          userIdField: 'email',
          userMetadataFields: ['email', 'username', 'role', 'provider'],
          conversationMetadataFields: ['conversationId', 'endpoint', 'model', 'spec'],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects trace fields outside the allowlists', () => {
    expect(
      configSchema.safeParse({
        version: '1.3.7',
        langfuse: { trace: { userIdField: 'password' } },
      }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({
        version: '1.3.7',
        langfuse: { trace: { userMetadataFields: ['totpSecret'] } },
      }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({
        version: '1.3.7',
        langfuse: { trace: { conversationMetadataFields: ['text'] } },
      }).success,
    ).toBe(false);
  });

  it('rejects non-string Langfuse header values', () => {
    const result = configSchema.safeParse({
      version: '1.3.7',
      langfuse: {
        headers: { 'X-Proxy-Token': 42 },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('interface.traceViewer', () => {
  it('accepts the documented fields and rejects out-of-range limits', () => {
    const parse = (traceViewer: Record<string, unknown>) =>
      interfaceSchema.safeParse({ traceViewer }).success;

    expect(
      parse({
        enabled: true,
        showInputOutput: true,
        showToolNames: true,
        maxRecords: 500,
        maxContentLength: 2000,
        requestsPerMinute: 10,
        requestTimeoutMs: 30_000,
      }),
    ).toBe(true);
    expect(parse({ showToolNames: 'yes' })).toBe(false);
    expect(parse({ requestTimeoutMs: 999 })).toBe(false);
    expect(parse({ requestTimeoutMs: 300_001 })).toBe(false);
    expect(parse({ maxRecords: 0 })).toBe(false);
    expect(parse({ maxRecords: 10_001 })).toBe(false);
    expect(parse({ maxContentLength: 1.5 })).toBe(false);
    expect(parse({ requestsPerMinute: 1001 })).toBe(false);
  });

  it('keeps the viewer off with the documented defaults when unset', () => {
    expect(resolveTraceViewerConfig(undefined)).toEqual(traceViewerDefaults);
    expect(interfaceSchema.parse({}).traceViewer).toBeUndefined();
  });

  it('names tool rounds from the tracing backend only when asked to', () => {
    expect(resolveTraceViewerConfig({ enabled: true }).showToolNames).toBe(false);
    expect(resolveTraceViewerConfig({ enabled: true, showToolNames: true }).showToolNames).toBe(
      true,
    );
  });

  it('re-validates overrides that bypassed the schema', () => {
    expect(
      resolveTraceViewerConfig({
        enabled: 'true',
        showInputOutput: 1,
        showToolNames: 'true',
        maxRecords: 50_000,
        maxContentLength: -5,
        requestsPerMinute: Number.NaN,
        requestTimeoutMs: 50,
      }),
    ).toEqual({
      enabled: false,
      showInputOutput: false,
      showToolNames: false,
      maxRecords: 10_000,
      maxContentLength: traceViewerDefaults.maxContentLength,
      requestsPerMinute: traceViewerDefaults.requestsPerMinute,
      requestTimeoutMs: traceViewerDefaults.requestTimeoutMs,
    });
  });
});
