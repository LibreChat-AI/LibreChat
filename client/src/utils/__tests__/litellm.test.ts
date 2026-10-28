import type { TMessage, TModelSpec } from 'librechat-data-provider';
import {
  getLiteLLMModelName,
  getLiteLLMAgentModelLabel,
  getLiteLLMRoutedModelLabel,
} from '~/utils/litellm';
import { areMessageFieldsEqual } from '~/utils/messages';

/** Shared content reference so the baseline compares equal on `content`, which
 *  the comparator diffs by reference. */
const SHARED_CONTENT = [] as TMessage['content'];

const makeFieldsMsg = (over: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'm1',
    text: 'hello',
    error: false,
    unfinished: false,
    finish_reason: 'stop',
    createdAt: '2026-07-01T00:00:00.000Z',
    depth: 0,
    isCreatedByUser: false,
    content: SHARED_CONTENT,
    model: 'gpt-4',
    endpoint: 'openAI',
    iconURL: '',
    ...over,
  }) as TMessage;

describe('getLiteLLMModelName', () => {
  it('reads the persisted model name', () => {
    expect(getLiteLLMModelName({ metadata: { litellmModelName: 'bedrock/claude' } })).toBe(
      'bedrock/claude',
    );
  });

  it('is undefined when absent, empty, or not a string', () => {
    expect(getLiteLLMModelName(undefined)).toBeUndefined();
    expect(getLiteLLMModelName({})).toBeUndefined();
    expect(getLiteLLMModelName({ metadata: { litellmModelName: '' } })).toBeUndefined();
    expect(getLiteLLMModelName({ metadata: { litellmModelName: 42 } })).toBeUndefined();
  });
});

describe('areMessageFieldsEqual litellmModelName', () => {
  it('stays equal when both messages carry the same model name', () => {
    const metadata = { litellmModelName: 'bedrock/claude' };
    expect(
      areMessageFieldsEqual(
        makeFieldsMsg({ metadata }),
        makeFieldsMsg({ metadata: { ...metadata } }),
      ),
    ).toBe(true);
  });

  it('re-renders when the saved model name arrives or changes', () => {
    expect(
      areMessageFieldsEqual(
        makeFieldsMsg(),
        makeFieldsMsg({ metadata: { litellmModelName: 'bedrock/claude' } }),
      ),
    ).toBe(false);
    expect(
      areMessageFieldsEqual(
        makeFieldsMsg({ metadata: { litellmModelName: 'bedrock/a' } }),
        makeFieldsMsg({ metadata: { litellmModelName: 'bedrock/b' } }),
      ),
    ).toBe(false);
  });
});

describe('areMessageFieldsEqual litellmAgentModels', () => {
  it("re-renders when an added column's served models arrive", () => {
    const agentModels = [{ agentId: 'a____1', modelName: 'bedrock/claude', spec: 'router' }];
    expect(
      areMessageFieldsEqual(
        makeFieldsMsg(),
        makeFieldsMsg({ metadata: { litellmAgentModels: agentModels } }),
      ),
    ).toBe(false);
    expect(
      areMessageFieldsEqual(
        makeFieldsMsg({ metadata: { litellmAgentModels: agentModels } }),
        makeFieldsMsg({ metadata: { usage: {}, litellmAgentModels: agentModels } }),
      ),
    ).toBe(true);
  });
});

describe('getLiteLLMRoutedModelLabel', () => {
  const modelSpecs = {
    list: [
      {
        name: 'litellm-model-router',
        label: 'Claude Auto',
        litellmRoutedModel: {
          showOnResponses: true,
          labels: [{ model: 'bedrock/claude-haiku', label: 'Claude Haiku' }],
        },
        preset: { endpoint: 'AnthropicClaude', model: 'litellm-model-router' },
      } as TModelSpec,
    ],
  };
  const routed = (modelName: string) =>
    makeFieldsMsg({
      metadata: { litellmModelName: modelName, litellmRoutedModelSpec: 'litellm-model-router' },
    });

  it('returns the configured label for the served model', () => {
    expect(getLiteLLMRoutedModelLabel(modelSpecs, routed('bedrock/claude-haiku'))).toBe(
      'Claude Haiku',
    );
  });

  it('falls back to the served model name without a configured label', () => {
    expect(getLiteLLMRoutedModelLabel(modelSpecs, routed('bedrock/claude-opus'))).toBe(
      'bedrock/claude-opus',
    );
  });

  it('is undefined when nothing was captured or the spec does not opt in', () => {
    expect(getLiteLLMRoutedModelLabel(modelSpecs, makeFieldsMsg())).toBeUndefined();
    expect(
      getLiteLLMRoutedModelLabel({ list: [] }, routed('bedrock/claude-haiku')),
    ).toBeUndefined();
  });
});

describe('getLiteLLMAgentModelLabel', () => {
  const modelSpecs = {
    list: [
      {
        name: 'litellm-model-router',
        label: 'Claude Auto',
        litellmRoutedModel: {
          showOnResponses: true,
          labels: [{ model: 'bedrock/claude-haiku', label: 'Claude Haiku' }],
        },
        preset: { endpoint: 'AnthropicClaude', model: 'litellm-model-router' },
      } as TModelSpec,
    ],
  };
  const PRIMARY = 'AnthropicClaude__litellm-model-router___Claude';
  const ADDED = 'AnthropicClaude__litellm-model-router___Claude____1';

  it("labels the primary column from the message's own fields", () => {
    const message = makeFieldsMsg({
      metadata: {
        litellmModelName: 'bedrock/claude-haiku',
        litellmRoutedModelSpec: 'litellm-model-router',
      },
    });

    expect(getLiteLLMAgentModelLabel(modelSpecs, message, PRIMARY)).toBe('Claude Haiku');
    expect(getLiteLLMAgentModelLabel(modelSpecs, message, ADDED)).toBeUndefined();
  });

  it('labels an added column from its own entry in litellmAgentModels', () => {
    const message = makeFieldsMsg({
      metadata: {
        litellmAgentModels: [
          { agentId: ADDED, modelName: 'bedrock/claude-opus', spec: 'litellm-model-router' },
        ],
      },
    });

    expect(getLiteLLMAgentModelLabel(modelSpecs, message, ADDED)).toBe('bedrock/claude-opus');
    expect(getLiteLLMAgentModelLabel(modelSpecs, message, PRIMARY)).toBeUndefined();
  });

  it('ignores a malformed entry, a non-list value or a spec that does not opt in', () => {
    const malformed = makeFieldsMsg({
      metadata: {
        litellmAgentModels: [{ agentId: ADDED, modelName: 42, spec: 'litellm-model-router' }],
      },
    });
    const notAList = makeFieldsMsg({
      metadata: {
        litellmAgentModels: {
          [ADDED]: { modelName: 'bedrock/claude-opus', spec: 'litellm-model-router' },
        },
      },
    });
    const unknownSpec = makeFieldsMsg({
      metadata: {
        litellmAgentModels: [{ agentId: ADDED, modelName: 'bedrock/x', spec: 'other' }],
      },
    });

    expect(getLiteLLMAgentModelLabel(modelSpecs, malformed, ADDED)).toBeUndefined();
    expect(getLiteLLMAgentModelLabel(modelSpecs, notAList, ADDED)).toBeUndefined();
    expect(getLiteLLMAgentModelLabel(modelSpecs, unknownSpec, ADDED)).toBeUndefined();
  });

  it('matches an agent id containing dots by value', () => {
    const dotted = 'openAI__gpt-4.1___GPT-4.1____1';
    const message = makeFieldsMsg({
      metadata: {
        litellmAgentModels: [
          { agentId: ADDED, modelName: 'bedrock/claude-opus', spec: 'litellm-model-router' },
          { agentId: dotted, modelName: 'bedrock/claude-haiku', spec: 'litellm-model-router' },
        ],
      },
    });

    expect(getLiteLLMAgentModelLabel(modelSpecs, message, dotted)).toBe('Claude Haiku');
  });
});
