import {
  CONTENT_TRAVERSAL_MAX_NODES,
  ContentTraversalLimitError,
  getContentTraversalFragments,
  getContentTraversalScopes,
  isContentTraversalProtected,
} from './nested';
import { inspectContent } from '../runtime';
import { extractChatContent } from './chat';

describe('extractChatContent', () => {
  it('bounds aggregate traversal across submitted chat arrays', () => {
    const examples = Array.from({ length: CONTENT_TRAVERSAL_MAX_NODES + 1 }, () => null);

    try {
      extractChatContent({ examples });
      throw new Error('expected traversal failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ContentTraversalLimitError);
      expect(getContentTraversalScopes(error as ContentTraversalLimitError)).toContainEqual({
        source: 'prompt',
        fields: ['example_input', 'example_output'],
      });
    }
  });

  it('classifies chat and resume fields in their legacy inspection order', () => {
    const editedArguments = { token: 'ORG-DEADBEEF' };
    const body = {
      text: 'typed text',
      quotes: ['  first quote  ', 'api-key:'],
      answer: 'resume answer',
      promptPrefix: 'agent guidance',
      instructions: 'assistant run instructions',
      decisions: [
        {
          responseText: 'decision response',
          reason: 'decision reason',
          editedArguments,
        },
      ],
    };

    const fragments = extractChatContent(body);

    expect(fragments).toEqual([
      {
        id: 'chat.text',
        path: '/text',
        text: 'typed text',
        source: 'message',
        field: 'text',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.quote.0',
        path: '/quotes/0',
        text: 'first quote',
        source: 'message',
        field: 'quote',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.quote.1',
        path: '/quotes/1',
        text: 'api-key:',
        source: 'message',
        field: 'quote',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.assembled.quote-text',
        path: '/$assembled/quote-text',
        text: '> first quote\n\n> api-key:\n\ntyped text',
        source: 'assembled_context',
        field: 'assembled_context',
        format: 'markdown',
        treatment: 'inspect_only',
        provenance: 'user',
      },
      {
        id: 'chat.answer',
        path: '/answer',
        text: 'resume answer',
        source: 'message',
        field: 'answer',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.prompt-prefix',
        path: '/promptPrefix',
        text: 'agent guidance',
        source: 'agent_instruction',
        field: 'instructions',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.prompt-prefix.preset',
        path: '/promptPrefix',
        text: 'agent guidance',
        source: 'prompt',
        field: 'preset_text',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.instructions',
        path: '/instructions',
        text: 'assistant run instructions',
        source: 'agent_instruction',
        field: 'instructions',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.decision.0.response',
        path: '/decisions/0/responseText',
        text: 'decision response',
        source: 'message',
        field: 'decision_response',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.decision.0.reason',
        path: '/decisions/0/reason',
        text: 'decision reason',
        source: 'message',
        field: 'decision_reason',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.decision.0.arguments',
        path: '/decisions/0/editedArguments',
        text: '{"token":"ORG-DEADBEEF"}',
        source: 'tool_argument',
        field: 'arguments',
        format: 'json',
        treatment: 'inspect_only',
        provenance: 'user',
      },
    ]);
    expect(body.quotes).toEqual(['  first quote  ', 'api-key:']);
    expect(body.decisions[0].editedArguments).toBe(editedArguments);
  });

  it('extracts model-bound edited content as a submitted message part', () => {
    expect(extractChatContent({ editedContent: { text: 'edited content text' } })).toEqual([
      {
        id: 'chat.edited-content.text',
        path: '/editedContent/text',
        text: 'edited content text',
        source: 'message',
        field: 'content_part',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
    ]);
  });

  it('extracts added-conversation instructions for an ephemeral secondary agent', () => {
    expect(
      extractChatContent({
        addedConvo: { promptPrefix: 'secondary agent instructions' },
      }),
    ).toEqual([
      {
        id: 'chat.added-conversation.prompt-prefix',
        path: '/addedConvo/promptPrefix',
        text: 'secondary agent instructions',
        source: 'agent_instruction',
        field: 'instructions',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.added-conversation.prompt-prefix.preset',
        path: '/addedConvo/promptPrefix',
        text: 'secondary agent instructions',
        source: 'prompt',
        field: 'preset_text',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
    ]);
  });

  it('classifies manually selected skill names before skill resolution', () => {
    const fragments = extractChatContent({
      manualSkills: ['safe-skill', null, 'PRIVATE-SKILL'],
    });

    expect(fragments).toEqual([
      {
        id: 'chat.manual-skill.0',
        path: '/manualSkills/0',
        text: 'safe-skill',
        source: 'skill',
        field: 'name',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.manual-skill.2',
        path: '/manualSkills/2',
        text: 'PRIVATE-SKILL',
        source: 'skill',
        field: 'name',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
    ]);

    expect(
      inspectContent(fragments, {
        filters: {
          skills: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
      }),
    ).toMatchObject({
      source: 'skill',
      field: 'name',
      ruleId: 'private',
    });
  });

  it.each([
    ['the primary preset', { promptPrefix: 'sk-pre-policy-primary' }],
    ['an added-conversation preset', { addedConvo: { promptPrefix: 'sk-pre-policy-added' } }],
  ])('retains the prompt source when replaying %s after policy tightening', (_name, body) => {
    const finding = inspectContent(extractChatContent(body), {
      filters: {
        prompts: {
          pii: {
            fields: ['preset_text'],
            starterPatterns: ['sk_prefix'],
          },
        },
      },
    });

    expect(finding).toEqual(
      expect.objectContaining({
        source: 'prompt',
        field: 'preset_text',
        ruleId: 'sk_prefix',
      }),
    );
  });

  it('extracts provider-bound parameters from a live chat submission', () => {
    expect(
      extractChatContent({
        stop: ['submitted stop'],
        additionalModelRequestFields: {
          thinking: { mode: 'submitted request field' },
        },
        response_format: {
          json_schema: { description: 'submitted response format' },
        },
        metadata: { label: 'submitted metadata' },
      }),
    ).toEqual([
      expect.objectContaining({
        source: 'model_parameter',
        field: 'stop',
        text: 'submitted stop',
        path: '/stop/0',
      }),
      expect.objectContaining({
        source: 'model_parameter',
        field: 'request_fields',
        text: 'thinking',
        path: '/additionalModelRequestFields/thinking',
      }),
      expect.objectContaining({
        source: 'model_parameter',
        field: 'request_fields',
        text: 'mode',
        path: '/additionalModelRequestFields/thinking/mode',
      }),
      expect.objectContaining({
        source: 'model_parameter',
        field: 'request_fields',
        text: 'submitted request field',
        path: '/additionalModelRequestFields/thinking/mode',
      }),
      expect.objectContaining({
        source: 'model_parameter',
        field: 'response_format',
        text: 'json_schema',
        path: '/response_format/json_schema',
      }),
      expect.objectContaining({
        source: 'model_parameter',
        field: 'response_format',
        text: 'description',
        path: '/response_format/json_schema/description',
      }),
      expect.objectContaining({
        source: 'model_parameter',
        field: 'response_format',
        text: 'submitted response format',
        path: '/response_format/json_schema/description',
      }),
      expect.objectContaining({
        source: 'model_parameter',
        field: 'metadata',
        text: 'label',
        path: '/metadata/label',
      }),
      expect.objectContaining({
        source: 'model_parameter',
        field: 'metadata',
        text: 'submitted metadata',
        path: '/metadata/label',
      }),
    ]);
  });

  it('extracts provider-bound prompt and instruction variants from live chat', () => {
    expect(
      extractChatContent({
        system: 'bedrock system text',
        context: 'google context',
        greeting: 'assistant greeting',
        additional_instructions: 'dynamic agent instructions',
        artifacts: 'assistant artifact mode',
        ephemeralAgent: { artifacts: 'ephemeral artifact mode' },
        examples: [
          {
            input: { content: 'google example input' },
            output: { content: 'google example output' },
          },
        ],
        addedConvo: {
          additional_instructions: 'secondary dynamic instructions',
          artifacts: 'secondary artifact mode',
          ephemeralAgent: { artifacts: 'secondary ephemeral artifact mode' },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'prompt',
          field: 'system',
          text: 'bedrock system text',
        }),
        expect.objectContaining({
          source: 'prompt',
          field: 'context',
          text: 'google context',
        }),
        expect.objectContaining({
          source: 'prompt',
          field: 'greeting',
          text: 'assistant greeting',
        }),
        expect.objectContaining({
          source: 'prompt',
          field: 'example_input',
          text: 'google example input',
        }),
        expect.objectContaining({
          source: 'prompt',
          field: 'example_output',
          text: 'google example output',
        }),
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'additional_instructions',
          text: 'dynamic agent instructions',
        }),
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'artifacts',
          text: 'ephemeral artifact mode',
        }),
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'additional_instructions',
          text: 'secondary dynamic instructions',
        }),
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'artifacts',
          text: 'secondary ephemeral artifact mode',
        }),
      ]),
    );
  });

  it('inspects cyclic edited arguments without dropping other fields', () => {
    const editedArguments: { protectedValue: string; self?: object } = {
      protectedValue: 'ORG-CYCLIC',
    };
    editedArguments.self = editedArguments;

    const fragments = extractChatContent({
      answer: 'safe answer',
      decisions: [{ editedArguments }],
    });

    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'chat.answer',
          text: 'safe answer',
        }),
        expect.objectContaining({
          id: 'chat.decision.0.arguments.nested.0',
          path: '/decisions/0/editedArguments/protectedValue',
          source: 'tool_argument',
          field: 'arguments',
          text: 'protectedValue',
        }),
        expect.objectContaining({
          path: '/decisions/0/editedArguments/protectedValue',
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-CYCLIC',
        }),
      ]),
    );
  });

  it('retains partial chat content and fails closed for legacy over-deep edited arguments', () => {
    interface DeepArguments {
      nested?: DeepArguments;
    }
    const editedArguments: DeepArguments = {};
    let current = editedArguments;
    for (let depth = 0; depth < 30; depth++) {
      current.nested = {};
      current = current.nested;
    }
    Object.defineProperty(editedArguments, 'toJSON', {
      value: () => {
        throw new Error('cannot serialize');
      },
    });

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractChatContent({
        answer: 'safe answer',
        decisions: [{ editedArguments }],
      });
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    expect(getContentTraversalScopes(traversalError as ContentTraversalLimitError)).toEqual([
      { source: 'tool_argument', fields: ['arguments'] },
    ]);
    expect(getContentTraversalFragments(traversalError as ContentTraversalLimitError)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'chat.answer',
          text: 'safe answer',
        }),
        expect.objectContaining({
          path: '/decisions/0/editedArguments/nested',
          source: 'tool_argument',
          field: 'arguments',
          text: 'nested',
        }),
      ]),
    );
    expect(
      isContentTraversalProtected({
        error: traversalError as ContentTraversalLimitError,
        legacyPii: {},
      }),
    ).toBe(true);
  });

  it('retains source indices when quote normalization drops unsupported entries', () => {
    const fragments = extractChatContent({
      quotes: [null, '  first quote  ', '', 42, 'second quote'],
    });

    expect(fragments).toEqual([
      {
        id: 'chat.quote.1',
        path: '/quotes/1',
        text: 'first quote',
        source: 'message',
        field: 'quote',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.quote.4',
        path: '/quotes/4',
        text: 'second quote',
        source: 'message',
        field: 'quote',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'chat.assembled.quote-text',
        path: '/$assembled/quote-text',
        text: '> first quote\n\n> second quote',
        source: 'assembled_context',
        field: 'assembled_context',
        format: 'markdown',
        treatment: 'inspect_only',
        provenance: 'user',
      },
    ]);
  });

  it('returns no fragments for empty or unsupported fields', () => {
    expect(extractChatContent(undefined)).toEqual([]);
    expect(extractChatContent({ text: '', quotes: [null, 42, '  '] })).toEqual([]);
  });
});
