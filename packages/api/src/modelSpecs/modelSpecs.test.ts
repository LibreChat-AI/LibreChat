import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import {
  applyModelSpecPreset,
  findModelSpecByName,
  isModelSpecEndpointMatch,
  resolveModelSpecForEndpoint,
  resolveModelSpecPromptPrefixVariables,
  sanitizeModelSpecs,
} from './index';

describe('modelSpecs helpers', () => {
  it('should strip private prompt fields from model spec presets', () => {
    const modelSpecs = {
      enforce: false,
      prioritize: true,
      list: [
        {
          name: 'guarded-spec',
          label: 'Guarded Spec',
          skills: ['private-skill'],
          subagents: { enabled: true, allowSelf: true, agent_ids: ['agent_private'] },
          preset: {
            endpoint: EModelEndpoint.openAI,
            model: 'gpt-4o',
            promptPrefix: 'private prompt prefix',
            instructions: 'private assistant instructions',
            additional_instructions: 'private additional instructions',
            system: 'private bedrock system',
            context: 'private context',
            examples: [{ input: { content: 'a' }, output: { content: 'b' } }],
            greeting: 'Hello',
          },
        },
      ],
    };

    const sanitizedModelSpecs = sanitizeModelSpecs(modelSpecs);
    expect(sanitizedModelSpecs.list[0].subagents).toEqual({
      enabled: true,
      allowSelf: true,
    });
    expect(sanitizedModelSpecs.list[0].preset).toEqual({
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
      greeting: 'Hello',
    });
    expect(sanitizedModelSpecs.list[0]).not.toHaveProperty('skills');
  });

  it('should preserve conversation starters on model specs', () => {
    const modelSpecs = {
      enforce: false,
      prioritize: true,
      list: [
        {
          name: 'starter-spec',
          label: 'Starter Spec',
          conversation_starters: ['Summarize an article', 'Plan my week'],
          preset: {
            endpoint: EModelEndpoint.openAI,
            model: 'gpt-4o',
            promptPrefix: 'private prompt prefix',
          },
        },
      ],
    };

    const sanitizedModelSpecs = sanitizeModelSpecs(modelSpecs);
    expect(sanitizedModelSpecs.list[0].conversation_starters).toEqual([
      'Summarize an article',
      'Plan my week',
    ]);
    expect(sanitizedModelSpecs.list[0].preset).not.toHaveProperty('promptPrefix');
  });

  it('should restore only private fields for non-enforced model specs', () => {
    const modelSpec: TModelSpec = {
      name: 'guarded-openai',
      label: 'Guarded OpenAI',
      iconURL: EModelEndpoint.openAI,
      preset: {
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
        promptPrefix: 'private prompt prefix',
        instructions: 'private instructions',
        additional_instructions: 'private additional instructions',
        temperature: 0.2,
        maxContextTokens: 10000,
      },
    };

    const { parsedBody, appliedPrivateFields, enforcedFields } = applyModelSpecPreset({
      modelSpec,
      parsedBody: {
        endpoint: EModelEndpoint.openAI,
        spec: 'guarded-openai',
        model: 'gpt-4o',
        temperature: 0.8,
      },
      endpoint: EModelEndpoint.openAI,
    });

    expect(parsedBody.promptPrefix).toBe('private prompt prefix');
    expect(parsedBody.instructions).toBeUndefined();
    expect(parsedBody.additional_instructions).toBeUndefined();
    expect(parsedBody.temperature).toBe(0.8);
    expect(parsedBody.maxContextTokens).toBeUndefined();
    expect(parsedBody.iconURL).toBe(EModelEndpoint.openAI);
    expect(appliedPrivateFields.has('promptPrefix')).toBe(true);
    /* The keys an enforced spec locks are exactly its preset's fields: the
       reasoning-override refusal rule keys off this set. */
    expect([...enforcedFields].sort()).toEqual([...Object.keys(modelSpec.preset)].sort());
  });

  it('should restore preset defaults when model specs are enforced', () => {
    const modelSpec: TModelSpec = {
      name: 'enforced-openai',
      label: 'Enforced OpenAI',
      preset: {
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
        promptPrefix: 'private prompt prefix',
        temperature: 0.2,
      },
    };

    const { parsedBody } = applyModelSpecPreset({
      modelSpec,
      parsedBody: {
        endpoint: EModelEndpoint.openAI,
        spec: 'enforced-openai',
        model: 'client-model',
        temperature: 0.8,
        topP: 0.9,
        chatProjectId: 'project-1',
      },
      endpoint: EModelEndpoint.openAI,
      includePresetDefaults: true,
    });

    expect(parsedBody.spec).toBe('enforced-openai');
    expect(parsedBody.model).toBe('gpt-4o');
    expect(parsedBody.promptPrefix).toBe('private prompt prefix');
    expect(parsedBody.temperature).toBe(0.2);
    expect(parsedBody.topP).toBeUndefined();
    expect(parsedBody.chatProjectId).toBe('project-1');
  });

  it('should restore private examples when parser supplies an empty default', () => {
    const examples = [{ input: { content: 'hello' }, output: { content: 'world' } }];
    const modelSpec: TModelSpec = {
      name: 'guarded-google',
      label: 'Guarded Google',
      preset: {
        endpoint: EModelEndpoint.google,
        model: 'gemini-pro',
        examples,
      },
    };

    const { parsedBody } = applyModelSpecPreset({
      modelSpec,
      parsedBody: {
        endpoint: EModelEndpoint.google,
        spec: 'guarded-google',
        model: 'gemini-pro',
      },
      endpoint: EModelEndpoint.google,
    });

    expect(parsedBody.examples).toEqual(examples);
  });

  it('should find specs and validate endpoint matches', () => {
    const modelSpec: TModelSpec = {
      name: 'guarded-openai',
      label: 'Guarded OpenAI',
      preset: {
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
      },
    };

    expect(findModelSpecByName({ list: [modelSpec] }, 'guarded-openai')).toBe(modelSpec);
    expect(isModelSpecEndpointMatch(modelSpec, EModelEndpoint.openAI)).toBe(true);
    expect(isModelSpecEndpointMatch(modelSpec, EModelEndpoint.google)).toBe(false);
  });

  it('should resolve a model spec only for its selected endpoint', () => {
    const modelSpec: TModelSpec = {
      name: 'restricted-agent',
      label: 'Restricted Agent',
      preset: { agent_id: 'agent_restricted' },
    } as TModelSpec;
    const modelSpecs = { list: [modelSpec] };

    expect(
      resolveModelSpecForEndpoint({
        modelSpecs,
        spec: 'restricted-agent',
        endpoint: EModelEndpoint.agents,
      }),
    ).toEqual({ modelSpec });
    expect(
      resolveModelSpecForEndpoint({
        modelSpecs,
        spec: 'missing-agent',
        endpoint: EModelEndpoint.agents,
      }),
    ).toEqual({ error: 'invalid-model-spec' });
    expect(
      resolveModelSpecForEndpoint({
        modelSpecs,
        spec: 'restricted-agent',
        endpoint: EModelEndpoint.openAI,
      }),
    ).toEqual({ error: 'model-spec-mismatch' });
  });

  /**
   * A preset naming an `agent_id` can only be served by the agents endpoint, so
   * omitting `endpoint` previously left the spec matching nothing at all.
   */
  it('should infer the agents endpoint when a preset omits it but names an agent', () => {
    const modelSpec: TModelSpec = {
      name: 'agent-spec',
      label: 'Agent Spec',
      preset: {
        agent_id: 'agent_abc',
      },
    } as TModelSpec;

    expect(isModelSpecEndpointMatch(modelSpec, EModelEndpoint.agents)).toBe(true);
    expect(isModelSpecEndpointMatch(modelSpec, EModelEndpoint.openAI)).toBe(false);
  });

  it('should keep an explicit endpoint over the inferred one', () => {
    const modelSpec: TModelSpec = {
      name: 'explicit-spec',
      label: 'Explicit Spec',
      preset: {
        endpoint: EModelEndpoint.openAI,
        agent_id: 'agent_abc',
      },
    } as TModelSpec;

    expect(isModelSpecEndpointMatch(modelSpec, EModelEndpoint.openAI)).toBe(true);
    expect(isModelSpecEndpointMatch(modelSpec, EModelEndpoint.agents)).toBe(false);
  });

  it('should not infer an endpoint for presets without an agent', () => {
    const modelSpec: TModelSpec = {
      name: 'bare-spec',
      label: 'Bare Spec',
      preset: {},
    } as TModelSpec;

    expect(isModelSpecEndpointMatch(modelSpec, EModelEndpoint.agents)).toBe(false);
  });

  it('should resolve special variables in model spec prompt prefixes', () => {
    expect(
      resolveModelSpecPromptPrefixVariables({ promptPrefix: 'Help {{current_user}}.' }, {
        name: 'Ada',
      } as never).promptPrefix,
    ).toBe('Help Ada.');
  });
});
