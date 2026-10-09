import type { FiltersConfig } from 'librechat-data-provider';
import {
  extractAgentContent,
  extractAssistantActionContent,
  extractAssistantContent,
  extractConversationImportContent,
  extractConversationTitleContent,
  extractFeedbackContent,
  extractFileContent,
  extractMemoryContent,
  extractModelParameterContent,
  extractPresetContent,
  extractPromptContent,
  extractSkillContent,
  extractStoredMessageContent,
  extractToolArgumentContent,
} from './submissions';
import {
  CONTENT_TRAVERSAL_MAX_DEPTH,
  CONTENT_TRAVERSAL_MAX_NODES,
  ContentTraversalLimitError,
  getContentTraversalFragments,
  getContentTraversalScopes,
  isContentTraversalProtected,
} from './nested';
import { inspectContent } from '../runtime';

function fieldValues(
  fragments: ReturnType<typeof extractAgentContent>,
): readonly { source: string; field: string; text: string; path: string }[] {
  return fragments.map(({ source, field, text, path }) => ({
    source,
    field,
    text,
    path,
  }));
}

describe('submitted content adapters', () => {
  it('inspects stored text assembled across adjacent content parts', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['assembled_context'],
          starterPatterns: [],
          customPatterns: [{ id: 'split-token', label: 'split token', regex: 'sk-SECRET' }],
        },
      },
    };

    const finding = inspectContent(
      extractStoredMessageContent({
        role: 'user',
        content: [{ text: 'sk-' }, { text: 'SECRET' }],
      }),
      { filters },
    );

    expect(finding).toMatchObject({
      source: 'assembled_context',
      field: 'assembled_context',
      label: 'split token',
    });
  });

  it('inspects persisted steer-part quotes as quote fragments', () => {
    // Steer parts persist their excerpts under `content[i].quotes`, mirroring
    // the top-level `message.quotes` — import and share preflights must see
    // them or blocked data could ride in on a quoted steer.
    const message = {
      role: 'assistant',
      content: [
        {
          type: 'steer',
          steer: 'about the selection',
          steerId: 's1',
          quotes: ['quoted secret excerpt'],
        },
      ],
    };

    expect(fieldValues(extractStoredMessageContent(message))).toEqual(
      expect.arrayContaining([
        {
          source: 'message',
          field: 'quote',
          text: 'quoted secret excerpt',
          path: '/content/0/quotes/0',
        },
      ]),
    );
  });

  it('classifies persisted and imported summary content parts as message summaries', () => {
    const message = {
      content: [{ type: 'summary', text: 'persisted summary text' }],
    };

    expect(fieldValues(extractStoredMessageContent(message))).toEqual(
      expect.arrayContaining([
        {
          source: 'message',
          field: 'content_part',
          text: 'persisted summary text',
          path: '/content/0/text',
        },
        {
          source: 'message',
          field: 'summary',
          text: 'persisted summary text',
          path: '/content/0/text',
        },
      ]),
    );
    expect(
      fieldValues(
        Array.from(
          extractConversationImportContent({
            conversations: [],
            messages: [message],
          }),
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          source: 'message',
          field: 'summary',
          text: 'persisted summary text',
          path: '/content/0/text',
        },
      ]),
    );
  });

  it('registers agent metadata, instructions, edges, and conversation starters separately', () => {
    expect(
      fieldValues(
        extractAgentContent({
          name: 'agent name',
          category: 'agent category',
          description: 'agent description',
          instructions: 'primary instructions',
          additional_instructions: 'additional instructions',
          conversation_starters: ['starter one', 'starter two'],
          edges: [
            {
              description: 'edge description',
              prompt: 'edge prompt',
              promptKey: 'edge key',
            },
          ],
          artifacts: 'artifact guidance',
          support_contact: { name: 'Support Person', email: 'support@example.test' },
          model_parameters: { stop: ['agent stop'] },
        }),
      ),
    ).toEqual([
      {
        source: 'agent_instruction',
        field: 'name',
        text: 'agent name',
        path: '/name',
      },
      {
        source: 'agent_instruction',
        field: 'category',
        text: 'agent category',
        path: '/category',
      },
      {
        source: 'agent_instruction',
        field: 'description',
        text: 'agent description',
        path: '/description',
      },
      {
        source: 'agent_instruction',
        field: 'instructions',
        text: 'primary instructions',
        path: '/instructions',
      },
      {
        source: 'agent_instruction',
        field: 'additional_instructions',
        text: 'additional instructions',
        path: '/additional_instructions',
      },
      {
        source: 'agent_instruction',
        field: 'artifacts',
        text: 'artifact guidance',
        path: '/artifacts',
      },
      {
        source: 'agent_instruction',
        field: 'support_contact_name',
        text: 'Support Person',
        path: '/support_contact/name',
      },
      {
        source: 'agent_instruction',
        field: 'support_contact_email',
        text: 'support@example.test',
        path: '/support_contact/email',
      },
      {
        source: 'conversation_starter',
        field: 'text',
        text: 'starter one',
        path: '/conversation_starters/0',
      },
      {
        source: 'conversation_starter',
        field: 'text',
        text: 'starter two',
        path: '/conversation_starters/1',
      },
      {
        source: 'agent_instruction',
        field: 'edge_description',
        text: 'edge description',
        path: '/edges/0/description',
      },
      {
        source: 'agent_instruction',
        field: 'edge_prompt',
        text: 'edge prompt',
        path: '/edges/0/prompt',
      },
      {
        source: 'agent_instruction',
        field: 'edge_prompt_key',
        text: 'edge key',
        path: '/edges/0/promptKey',
      },
      {
        source: 'model_parameter',
        field: 'stop',
        text: 'agent stop',
        path: '/model_parameters/stop/0',
      },
    ]);
  });

  it('registers assistant function definitions and action specifications', () => {
    expect(
      fieldValues(
        extractAssistantContent({
          name: 'assistant name',
          instructions: 'assistant instructions',
          conversation_starters: ['assistant starter'],
          tools: [
            'file_search',
            {
              type: 'function',
              function: {
                name: 'lookup_customer',
                description: 'Look up a customer',
                parameters: {
                  type: 'object',
                  properties: { email: { type: 'string', description: 'Customer email' } },
                },
              },
            },
          ],
          response_format: {
            json_schema: { description: 'Assistant response schema' },
          },
          metadata: { label: 'Assistant metadata' },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'name',
          text: 'assistant name',
          path: '/name',
        }),
        expect.objectContaining({
          source: 'conversation_starter',
          field: 'text',
          text: 'assistant starter',
          path: '/conversation_starters/0',
        }),
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'name',
          text: 'lookup_customer',
          path: '/tools/1/function/name',
        }),
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'description',
          text: 'Look up a customer',
          path: '/tools/1/function/description',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: expect.stringContaining('Customer email'),
          path: '/tools/1/function/parameters',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'response_format',
          text: 'Assistant response schema',
          path: '/response_format/json_schema/description',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'metadata',
          text: 'Assistant metadata',
          path: '/metadata/label',
        }),
      ]),
    );

    expect(
      fieldValues(
        extractAssistantActionContent({
          functions: [
            {
              name: 'direct_function',
              description: 'Direct function description',
              parameters: { type: 'object' },
            },
          ],
          metadata: { raw_spec: 'openapi: 3.0.0\ninfo:\n  title: Submitted action' },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        source: 'agent_instruction',
        field: 'name',
        text: 'direct_function',
        path: '/functions/0/name',
      }),
      expect.objectContaining({
        source: 'tool_argument',
        field: 'name',
        text: 'direct_function',
        path: '/functions/0/name',
      }),
      expect.objectContaining({
        source: 'agent_instruction',
        field: 'description',
        text: 'Direct function description',
        path: '/functions/0/description',
      }),
      expect.objectContaining({
        source: 'tool_argument',
        field: 'arguments',
        text: '{"type":"object"}',
        path: '/functions/0/parameters',
      }),
      expect.objectContaining({
        source: 'tool_argument',
        field: 'arguments',
        text: 'openapi: 3.0.0\ninfo:\n  title: Submitted action',
        path: '/metadata/raw_spec',
      }),
      expect.objectContaining({
        source: 'action_metadata',
        field: 'raw_spec',
        text: 'openapi: 3.0.0\ninfo:\n  title: Submitted action',
        path: '/metadata/raw_spec',
      }),
    ]);
  });

  it('registers every submitted action metadata and nested authorization field', () => {
    expect(
      fieldValues(
        extractAssistantActionContent({
          metadata: {
            raw_spec: 'submitted spec',
            domain: 'https://api.example.test',
            privacy_policy_url: 'https://example.test/privacy',
            api_key: 'submitted api key',
            oauth_client_id: 'submitted client id',
            oauth_client_secret: 'submitted client secret',
            auth: {
              authorization_type: 'custom',
              custom_auth_header: 'X-Custom-Auth',
              authorization_content_type: 'application/x-www-form-urlencoded',
              authorization_url: 'https://auth.example.test/authorize',
              client_url: 'https://auth.example.test/token',
              scope: 'read write',
              token_exchange_method: 'basic_auth_header',
            },
          },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'action_metadata',
          field: 'raw_spec',
          text: 'submitted spec',
          path: '/metadata/raw_spec',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'domain',
          text: 'https://api.example.test',
          path: '/metadata/domain',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'privacy_policy_url',
          text: 'https://example.test/privacy',
          path: '/metadata/privacy_policy_url',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'api_key',
          text: 'submitted api key',
          path: '/metadata/api_key',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'oauth_client_id',
          text: 'submitted client id',
          path: '/metadata/oauth_client_id',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'oauth_client_secret',
          text: 'submitted client secret',
          path: '/metadata/oauth_client_secret',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'authorization_type',
          text: 'custom',
          path: '/metadata/auth/authorization_type',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'custom_auth_header',
          text: 'X-Custom-Auth',
          path: '/metadata/auth/custom_auth_header',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'authorization_content_type',
          text: 'application/x-www-form-urlencoded',
          path: '/metadata/auth/authorization_content_type',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'authorization_url',
          text: 'https://auth.example.test/authorize',
          path: '/metadata/auth/authorization_url',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'client_url',
          text: 'https://auth.example.test/token',
          path: '/metadata/auth/client_url',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'scope',
          text: 'read write',
          path: '/metadata/auth/scope',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'token_exchange_method',
          text: 'basic_auth_header',
          path: '/metadata/auth/token_exchange_method',
        }),
      ]),
    );
  });

  it('serializes structured action specs for source-specific inspection', () => {
    expect(
      fieldValues(
        extractAssistantActionContent({
          metadata: {
            raw_spec: {
              openapi: '3.0.0',
              info: { title: 'Submitted action' },
            },
          },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'action_metadata',
          field: 'raw_spec',
          text: '{"openapi":"3.0.0","info":{"title":"Submitted action"}}',
          path: '/metadata/raw_spec',
        }),
      ]),
    );
  });

  it('keeps bounded fragments and exact scopes for oversized tool definitions', () => {
    const createDeepValue = (visible: string): Record<string, unknown> => {
      const root: Record<string, unknown> = { visible };
      let current = root;
      for (let depth = 0; depth < CONTENT_TRAVERSAL_MAX_DEPTH; depth++) {
        const nested: Record<string, unknown> = {};
        current.nested = nested;
        current = nested;
      }
      current.nested = { hidden: 'ORG-HIDDEN-OVERFLOW' };
      return root;
    };
    const captureTraversalError = (extract: () => unknown): ContentTraversalLimitError => {
      try {
        extract();
      } catch (error) {
        if (error instanceof ContentTraversalLimitError) {
          return error;
        }
        throw error;
      }
      throw new Error('Expected bounded traversal to fail closed');
    };

    const parameterError = captureTraversalError(() =>
      extractAssistantContent({
        name: 'visible assistant name',
        tools: [
          {
            type: 'function',
            function: {
              name: 'visible_function',
              parameters: createDeepValue('ORG-VISIBLE-PARAMETER'),
            },
          },
        ],
      }),
    );
    expect(getContentTraversalScopes(parameterError)).toEqual([
      { source: 'tool_argument', fields: ['arguments'] },
    ]);
    expect(getContentTraversalFragments(parameterError)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'name',
          text: 'visible assistant name',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-VISIBLE-PARAMETER',
          path: '/tools/0/function/parameters/visible',
        }),
      ]),
    );

    const actionError = captureTraversalError(() =>
      extractAssistantActionContent({
        metadata: { raw_spec: createDeepValue('ORG-VISIBLE-SPEC') },
      }),
    );
    expect(getContentTraversalScopes(actionError)).toEqual([
      { source: 'tool_argument', fields: ['arguments'] },
      { source: 'action_metadata', fields: ['raw_spec'] },
    ]);
    expect(getContentTraversalFragments(actionError)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-VISIBLE-SPEC',
          path: '/metadata/raw_spec/visible',
        }),
        expect.objectContaining({
          source: 'action_metadata',
          field: 'raw_spec',
          text: 'ORG-VISIBLE-SPEC',
          path: '/metadata/raw_spec/visible',
        }),
      ]),
    );
  });

  it('extracts prompt records and the real nested preset example shape', () => {
    expect(
      fieldValues(
        extractPromptContent({
          name: 'root name',
          prompt: {
            name: 'nested name',
            description: 'nested description',
            prompt: 'nested prompt text',
          },
          group: {
            name: 'group name',
            oneliner: 'group one-liner',
          },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'name', text: 'root name', path: '/name' }),
        expect.objectContaining({
          field: 'text',
          text: 'nested prompt text',
          path: '/prompt/prompt',
        }),
        expect.objectContaining({
          field: 'oneliner',
          text: 'group one-liner',
          path: '/group/oneliner',
        }),
      ]),
    );

    const preset = fieldValues(
      extractPresetContent({
        title: 'preset title',
        promptPrefix: 'prefix text',
        system: 'system text',
        context: 'context text',
        instructions: 'instruction text',
        additional_instructions: 'additional text',
        greeting: 'greeting text',
        examples: [
          {
            input: { content: 'nested input' },
            output: { content: 'nested output' },
          },
          { input: 'legacy input', output: 'legacy output' },
        ],
        stop: ['preset stop'],
      }),
    );

    expect(preset).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'context', text: 'context text' }),
        expect.objectContaining({
          field: 'additional_instructions',
          text: 'additional text',
        }),
        expect.objectContaining({
          field: 'example_input',
          text: 'nested input',
          path: '/examples/0/input/content',
        }),
        expect.objectContaining({
          field: 'example_output',
          text: 'nested output',
          path: '/examples/0/output/content',
        }),
        expect.objectContaining({
          field: 'example_input',
          text: 'legacy input',
          path: '/examples/1/input',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'stop',
          text: 'preset stop',
          path: '/stop/0',
        }),
      ]),
    );
  });

  it('walks only the registered skill fields, including nested frontmatter and file text', () => {
    const frontmatter: Record<string, unknown> = {
      'ORG-SECRET': true,
      owner: 'owner text',
      nested: { labels: ['first label', { value: 'deep value' }] },
    };
    frontmatter.self = frontmatter;
    const input = {
      name: 'skill name',
      body: 'body instructions',
      instructions: 'alternate instructions',
      importedText: 'imported instructions',
      frontmatter,
      files: [
        {
          name: 'name alias',
          filename: 'file name',
          text: 'file text',
          content: 'content alias',
        },
      ],
      unregisteredCredential: 'must not be traversed',
    };

    const fragments = fieldValues(extractSkillContent(input));

    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'instructions', text: 'body instructions' }),
        expect.objectContaining({ field: 'instructions', text: 'alternate instructions' }),
        expect.objectContaining({
          field: 'frontmatter',
          text: 'ORG-SECRET',
          path: '/frontmatter/ORG-SECRET',
        }),
        expect.objectContaining({
          field: 'frontmatter',
          text: 'deep value',
          path: '/frontmatter/nested/labels/1/value',
        }),
        expect.objectContaining({ field: 'file_name', text: 'name alias' }),
        expect.objectContaining({ field: 'file_name', text: 'file name' }),
        expect.objectContaining({ field: 'file_text', text: 'file text' }),
        expect.objectContaining({ field: 'file_text', text: 'content alias' }),
      ]),
    );
    expect(fragments.some(({ text }) => text === input.unregisteredCredential)).toBe(false);
  });

  it('fails closed with the skill frontmatter scope when bounded traversal is incomplete', () => {
    type NestedFrontmatter = Record<string, unknown> & {
      nested?: NestedFrontmatter;
    };

    const frontmatter: NestedFrontmatter = {
      visible: 'ORG-VISIBLE-FRONTMATTER',
    };
    let current: NestedFrontmatter = frontmatter;
    for (let depth = 0; depth < CONTENT_TRAVERSAL_MAX_DEPTH; depth++) {
      current.nested = {};
      current = current.nested;
    }
    let overflowValueRead = false;
    const overflow: Record<string, unknown> = {};
    Object.defineProperty(overflow, 'protected_value', {
      enumerable: true,
      get() {
        overflowValueRead = true;
        return 'ORG-OVERFLOW-FRONTMATTER';
      },
    });
    current.nested = overflow;

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractSkillContent({ frontmatter });
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    const error = traversalError as ContentTraversalLimitError;
    expect(getContentTraversalScopes(error)).toEqual([
      { source: 'skill', fields: ['frontmatter'] },
    ]);
    expect(getContentTraversalFragments(error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'skill',
          field: 'frontmatter',
          text: 'ORG-VISIBLE-FRONTMATTER',
          path: '/frontmatter/visible',
        }),
      ]),
    );
    expect(overflowValueRead).toBe(false);

    const broadFrontmatter = Object.fromEntries(
      Array.from({ length: CONTENT_TRAVERSAL_MAX_NODES - 1 }, (_, index) => [
        `field_${index}`,
        'safe',
      ]),
    );
    let overflowNodeRead = false;
    Object.defineProperty(broadFrontmatter, 'overflow_node', {
      enumerable: true,
      get() {
        overflowNodeRead = true;
        return 'ORG-OVERFLOW-NODE';
      },
    });
    expect(() => extractSkillContent({ frontmatter: broadFrontmatter })).toThrow(
      ContentTraversalLimitError,
    );
    expect(overflowNodeRead).toBe(false);
  });

  it('extracts memory, file, feedback, and title fields without collapsing supplied aliases', () => {
    expect(fieldValues(extractMemoryContent({ key: 'k', value: 'v', summary: 's' }))).toEqual([
      expect.objectContaining({ source: 'memory', field: 'key', text: 'k' }),
      expect.objectContaining({ source: 'memory', field: 'value', text: 'v' }),
      expect.objectContaining({ source: 'memory', field: 'summary', text: 's' }),
    ]);
    expect(
      fieldValues(
        extractFileContent({
          name: 'name',
          filename: 'filename',
          originalname: 'original',
          content: 'raw content',
          extractedText: 'extracted',
          text: 'text alias',
          transcript: 'transcript',
          uri: 'https://example.test/file',
          filepath: '/tmp/file',
          url: 'https://example.test/url-alias',
          preview: 'https://example.test/preview-alias',
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'file', field: 'name', text: 'name' }),
        expect.objectContaining({ source: 'file', field: 'name', text: 'filename' }),
        expect.objectContaining({ source: 'file', field: 'content', text: 'raw content' }),
        expect.objectContaining({ source: 'file', field: 'extracted_text', text: 'extracted' }),
        expect.objectContaining({ source: 'file', field: 'extracted_text', text: 'text alias' }),
        expect.objectContaining({ source: 'file', field: 'transcript', text: 'transcript' }),
        expect.objectContaining({ source: 'file', field: 'uri', text: '/tmp/file' }),
        expect.objectContaining({
          source: 'file',
          field: 'uri',
          text: 'https://example.test/url-alias',
        }),
        expect.objectContaining({
          source: 'file',
          field: 'uri',
          text: 'https://example.test/preview-alias',
        }),
      ]),
    );
    expect(
      fieldValues(extractFeedbackContent({ feedback: { text: 'nested' }, text: 'direct' })),
    ).toEqual([
      expect.objectContaining({ source: 'feedback', field: 'text', text: 'nested' }),
      expect.objectContaining({ source: 'feedback', field: 'text', text: 'direct' }),
    ]);
    expect(fieldValues(extractConversationTitleContent('title text'))).toEqual([
      expect.objectContaining({
        source: 'conversation_title',
        field: 'title',
        text: 'title text',
      }),
    ]);
  });

  it('normalizes persisted text by MIME and extraction provenance for field-level inspection', () => {
    expect(
      fieldValues(
        extractFileContent({
          file_id: 'text-file',
          type: 'text/plain',
          source: 'text',
          text: 'submitted text',
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'content', text: 'submitted text' }),
        expect.objectContaining({ field: 'extracted_text', text: 'submitted text' }),
      ]),
    );

    expect(
      fieldValues(
        extractFileContent({
          file_id: 'audio-file',
          type: 'audio/webm',
          source: 'text',
          text: 'submitted transcript',
        }),
      ),
    ).toEqual([expect.objectContaining({ field: 'transcript', text: 'submitted transcript' })]);

    for (const transcript of ['', ' \n\t']) {
      expect(
        fieldValues(
          extractFileContent({
            file_id: 'audio-file-with-blank-transcript',
            type: 'audio/webm',
            source: 'text',
            text: 'submitted transcript fallback',
            transcript,
          }),
        ),
      ).toEqual([
        expect.objectContaining({ field: 'transcript', text: 'submitted transcript fallback' }),
      ]);
    }

    expect(
      fieldValues(
        extractFileContent({
          file_id: 'legacy-binary-file',
          type: 'application/pdf',
          source: 'local',
          text: 'legacy preview text',
        }),
      ),
    ).toEqual([expect.objectContaining({ field: 'extracted_text', text: 'legacy preview text' })]);
  });

  it('routes a canonical audio text fallback only through transcript policy', () => {
    const fragments = extractFileContent({
      file_id: 'audio-file-with-blank-transcript',
      type: 'audio/webm',
      source: 'text',
      text: 'TRANSCRIPT-ONLY-SECRET',
      transcript: ' \n\t',
    });
    const customPatterns = [
      { id: 'transcript-secret', label: 'transcript secret', regex: 'TRANSCRIPT-ONLY-SECRET' },
    ];

    expect(
      inspectContent(fragments, {
        filters: {
          files: { pii: { fields: ['extracted_text'], starterPatterns: [], customPatterns } },
        },
      }),
    ).toBeNull();
    expect(
      inspectContent(fragments, {
        filters: {
          files: { pii: { fields: ['transcript'], starterPatterns: [], customPatterns } },
        },
      }),
    ).toMatchObject({ source: 'file', field: 'transcript', label: 'transcript secret' });
  });

  it('extracts only registered provider-bound model parameter strings through stored wrappers', () => {
    const fragments = fieldValues(
      extractModelParameterContent({
        stop: ['top-level stop'],
        additionalModelRequestFields: {
          nested: { value: 'request field value' },
        },
        responseFormat: {
          json_schema: {
            description: 'response format description',
            schema: { properties: { 'ORG-SECRET': { type: 'string' } } },
          },
        },
        metadata: { tenant: 'metadata value' },
        model_parameters: {
          stop: 'stored stop',
          additionalModelRequestFields: { beta: 'stored request field' },
          vendorOption: { secret: 'stored vendor option' },
        },
        options: {
          response_format: { type: 'nested response format' },
          metadata: { label: 'nested metadata' },
          customProviderOption: 'nested provider option',
        },
        ignored: 'must not be traversed',
      } as Parameters<typeof extractModelParameterContent>[0]),
    );

    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'model_parameter',
          field: 'stop',
          text: 'top-level stop',
          path: '/stop/0',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'request_fields',
          text: 'request field value',
          path: '/additionalModelRequestFields/nested/value',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'response_format',
          text: 'response format description',
          path: '/responseFormat/json_schema/description',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'response_format',
          text: 'ORG-SECRET',
          path: '/responseFormat/json_schema/schema/properties/ORG-SECRET',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'metadata',
          text: 'metadata value',
          path: '/metadata/tenant',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'stop',
          text: 'stored stop',
          path: '/model_parameters/stop',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'request_fields',
          text: 'stored request field',
          path: '/model_parameters/additionalModelRequestFields/beta',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'request_fields',
          text: 'stored vendor option',
          path: '/model_parameters/vendorOption/secret',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'response_format',
          text: 'nested response format',
          path: '/options/response_format/type',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'metadata',
          text: 'nested metadata',
          path: '/options/metadata/label',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'request_fields',
          text: 'nested provider option',
          path: '/options/customProviderOption',
        }),
      ]),
    );
    expect(fragments.some(({ text }) => text === 'must not be traversed')).toBe(false);
    expect(fragments.filter(({ path }) => path === '/model_parameters/stop')).toHaveLength(1);
    expect(fragments.filter(({ path }) => path === '/options/metadata/label')).toHaveLength(2);
  });

  it('fails closed when registered model parameter content exceeds the depth budget', () => {
    interface NestedModelParameter {
      nested?: NestedModelParameter;
    }

    const metadata: NestedModelParameter = {};
    let current = metadata;
    for (let depth = 0; depth < 25; depth++) {
      current.nested = {};
      current = current.nested;
    }

    expect(() => extractModelParameterContent({ metadata })).toThrow(ContentTraversalLimitError);
  });

  it('fails closed when nested model parameter wrappers exceed the depth budget', () => {
    let nested: Parameters<typeof extractModelParameterContent>[0] = {};
    for (let depth = 0; depth < 25; depth++) {
      nested = { model_parameters: nested };
    }

    expect(() => extractModelParameterContent({ options: nested })).toThrow(
      ContentTraversalLimitError,
    );
  });

  it('fails closed when a model parameter wrapper exceeds the node budget', () => {
    const options = Object.fromEntries(
      Array.from({ length: 4096 }, (_, index) => [`provider_option_${index}`, 'value']),
    );

    expect(() => extractModelParameterContent({ options })).toThrow(ContentTraversalLimitError);
  });

  it('does not read model parameter properties beyond the traversal budget', () => {
    const options = Object.fromEntries(
      Array.from({ length: CONTENT_TRAVERSAL_MAX_NODES }, (_, index) => [
        `provider_option_${index}`,
        'value',
      ]),
    );
    let overflowValueRead = false;
    Object.defineProperty(options, 'overflow_value', {
      enumerable: true,
      get() {
        overflowValueRead = true;
        return 'PRIVATE-OVERFLOW';
      },
    });

    expect(() => extractModelParameterContent({ options })).toThrow(ContentTraversalLimitError);
    expect(overflowValueRead).toBe(false);
  });

  it('shares the node budget across sibling model-parameter subtrees', () => {
    const options = {
      first_provider_option: Array.from({ length: 1_500 }, (_, index) => `first-${index}`),
      second_provider_option: Array.from({ length: 1_500 }, (_, index) => `second-${index}`),
      third_provider_option: Array.from({ length: 1_500 }, (_, index) => `third-${index}`),
    };

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractModelParameterContent({ options });
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    expect(getContentTraversalScopes(traversalError as ContentTraversalLimitError)).toEqual([
      { source: 'model_parameter', fields: ['request_fields'] },
    ]);
    expect(getContentTraversalFragments(traversalError as ContentTraversalLimitError)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'first-1499' }),
        expect.objectContaining({ text: 'second-1499' }),
      ]),
    );
  });

  it('reports the exact model parameter field whose traversal was incomplete', () => {
    let value: unknown = 'safe';
    for (let depth = 0; depth < 30; depth++) {
      value = { nested: value };
    }

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractModelParameterContent({ options: { provider_option: value } });
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    expect(traversalError).not.toBeNull();
    expect(getContentTraversalScopes(traversalError as ContentTraversalLimitError)).toEqual([
      { source: 'model_parameter', fields: ['request_fields'] },
    ]);
    expect((traversalError as ContentTraversalLimitError).body).toMatchObject({
      source: 'model_parameter',
      field: 'request_fields',
    });
  });

  it('keeps an exhausted unknown wrapper branch scoped away from inspected stop content', () => {
    let value: unknown = 'safe';
    for (let depth = 0; depth < 30; depth++) {
      value = { nested: value };
    }

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractModelParameterContent({
        options: {
          stop: 'safe stop value',
          provider_option: value,
        },
      });
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    expect(getContentTraversalScopes(traversalError as ContentTraversalLimitError)).toEqual([
      { source: 'model_parameter', fields: ['request_fields'] },
    ]);
    expect(getContentTraversalFragments(traversalError as ContentTraversalLimitError)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'stop',
          text: 'safe stop value',
        }),
      ]),
    );
  });

  it('conservatively scopes an exhausted wrapper chain to every possible field', () => {
    let nested: unknown = { stop: 'PRIVATE-SENTINEL' };
    for (let depth = 0; depth < 60; depth++) {
      nested = { options: nested };
    }

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractModelParameterContent({ options: nested });
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    expect(getContentTraversalScopes(traversalError as ContentTraversalLimitError)).toEqual([
      {
        source: 'model_parameter',
        fields: ['stop', 'request_fields', 'response_format', 'metadata'],
      },
    ]);
  });

  it('fails closed when the root model-parameter object cannot be enumerated', () => {
    const opaqueRoot = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('unavailable');
        },
      },
    );

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractModelParameterContent(opaqueRoot);
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    expect(getContentTraversalScopes(traversalError as ContentTraversalLimitError)).toEqual([
      {
        source: 'model_parameter',
        fields: ['stop', 'request_fields', 'response_format', 'metadata'],
      },
    ]);
  });

  it('retains later import content when an earlier model parameter traversal is incomplete', () => {
    let value: unknown = 'safe';
    for (let depth = 0; depth < 30; depth++) {
      value = { nested: value };
    }

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      Array.from(
        extractConversationImportContent({
          conversations: [
            { options: { provider_option: value } },
            { presetOverride: { instructions: 'later prompt content' } },
          ],
          messages: [{ text: 'later message content' }],
        }),
      );
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    const fragments = getContentTraversalFragments(traversalError as ContentTraversalLimitError);
    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'prompt',
          field: 'instructions',
          text: 'later prompt content',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'text',
          text: 'later message content',
        }),
      ]),
    );
  });

  it('extracts stored message parts, attachment references, and every tool argument shape', () => {
    const dataUri = `data:image/png;base64,${'a'.repeat(1024)}`;
    const fragments = fieldValues(
      extractStoredMessageContent({
        name: 'message name',
        sender: 'imported sender',
        text: 'message text',
        summary: 'message summary',
        feedback: { text: 'message feedback' },
        quotes: ['quote text', { text: 'structured quote' }],
        content: [
          {
            text: { value: 'structured text' },
            think: 'thinking text',
            steer: 'steering text',
            content: [{ text: 'summary text' }],
            image_url: { url: dataUri },
            video_url: { url: 'https://example.test/video?token=ORG-VIDEO' },
            files: [
              {
                file_id: 'file-ORG-ID',
                name: 'ORG-display-name.txt',
                filename: 'ORG-name.txt',
              },
            ],
            tool_call: {
              name: 'ORG-DIRECT-TOOL',
              args: { token: 'ORG-ARGS' },
              arguments: 'ORG-DIRECT',
              function: {
                name: 'ORG-FUNCTION-TOOL',
                arguments: 'ORG-FUNCTION',
                output: 'ORG-FUNCTION-OUTPUT',
              },
              code_interpreter: {
                input: 'ORG-CODE-INPUT',
                outputs: [{ logs: 'ORG-CODE-OUTPUT' }],
              },
              output: { token: 'ORG-OUTPUT' },
            },
          },
        ],
        tool_calls: [
          {
            name: 'ORG-TOP-DIRECT-TOOL',
            arguments: 'ORG-TOP-DIRECT',
            function: {
              name: 'ORG-TOP-FUNCTION-TOOL',
              arguments: 'ORG-TOP-FUNCTION',
              output: 'ORG-TOP-FUNCTION-OUTPUT',
            },
            code_interpreter: {
              input: 'ORG-TOP-CODE-INPUT',
              outputs: [{ logs: 'ORG-TOP-CODE-OUTPUT' }],
            },
            output: 'ORG-TOP-OUTPUT',
          },
        ],
        attachments: [
          {
            uri: 'https://example.test/file?token=ORG-URI',
            url: 'https://example.test/file?token=ORG-URL',
            preview: 'https://example.test/file?token=ORG-PREVIEW',
          },
        ],
      }),
    );

    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'message', field: 'name', text: 'message name' }),
        expect.objectContaining({ source: 'message', field: 'name', text: 'imported sender' }),
        expect.objectContaining({ source: 'message', field: 'text', text: 'message text' }),
        expect.objectContaining({
          source: 'message',
          field: 'summary',
          text: 'message summary',
        }),
        expect.objectContaining({
          source: 'feedback',
          field: 'text',
          text: 'message feedback',
        }),
        expect.objectContaining({ source: 'message', field: 'quote', text: 'structured quote' }),
        expect.objectContaining({
          source: 'message',
          field: 'content_part',
          text: 'steering text',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'attachment_reference',
          text: 'ORG-name.txt',
        }),
        expect.objectContaining({
          source: 'file',
          field: 'name',
          text: 'ORG-name.txt',
        }),
        expect.objectContaining({
          source: 'file',
          field: 'uri',
          text: 'https://example.test/file?token=ORG-URI',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'attachment_reference',
          text: 'https://example.test/file?token=ORG-URL',
        }),
        expect.objectContaining({
          source: 'file',
          field: 'uri',
          text: 'https://example.test/file?token=ORG-URL',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'attachment_reference',
          text: 'https://example.test/file?token=ORG-PREVIEW',
        }),
        expect.objectContaining({
          source: 'file',
          field: 'uri',
          text: 'https://example.test/file?token=ORG-PREVIEW',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'name',
          text: 'ORG-FUNCTION-TOOL',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: '{"token":"ORG-ARGS"}',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-FUNCTION',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'output',
          text: '{"token":"ORG-OUTPUT"}',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'output',
          text: 'ORG-FUNCTION-OUTPUT',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-CODE-INPUT',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'output',
          text: '[{"logs":"ORG-CODE-OUTPUT"}]',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-TOP-FUNCTION',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'output',
          text: 'ORG-TOP-FUNCTION-OUTPUT',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-TOP-CODE-INPUT',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'output',
          text: '[{"logs":"ORG-TOP-CODE-OUTPUT"}]',
        }),
      ]),
    );
    expect(fragments.some(({ text }) => text.includes(dataUri))).toBe(false);
  });

  it('extracts unknown nested stored content without duplicating known fields or encoded data', () => {
    const part = {
      type: 'vendor_content',
      text: 'known text',
      content: [
        {
          text: 'known nested text',
          vendor: { description: 'unknown nested description' },
        },
      ],
      tool_call: {
        name: 'known tool name',
        vendor: { description: 'unknown tool description' },
      },
      source: {
        type: 'json',
        label: 'unknown source label',
      },
      document: {
        type: 'base64',
        data: 'encoded-document-payload',
      },
    };
    const cyclic: { part?: unknown } = {};
    cyclic.part = cyclic;
    Object.assign(part, { cyclic });

    const fragments = fieldValues(extractStoredMessageContent({ role: 'system', content: [part] }));

    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'message',
          field: 'content_part',
          path: '/content/0/content/0/vendor/description',
          text: 'unknown nested description',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'content_part',
          path: '/content/0/source/label',
          text: 'unknown source label',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'content_part',
          path: '/content/0/tool_call/vendor/description',
          text: 'unknown tool description',
        }),
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'instructions',
          path: '/content/0/source/label',
          text: 'unknown source label',
        }),
      ]),
    );
    expect(
      fragments.filter(({ source, text }) => source === 'message' && text === 'known text'),
    ).toHaveLength(1);
    expect(
      fragments.filter(({ source, text }) => source === 'message' && text === 'known nested text'),
    ).toHaveLength(1);
    expect(
      fragments.filter(
        ({ source, field, text }) =>
          source === 'tool_argument' && field === 'name' && text === 'known tool name',
      ),
    ).toHaveLength(1);
    expect(fragments.some(({ text }) => text.includes('encoded-document'))).toBe(false);
    expect(fragments.some(({ text }) => text === 'vendor_content')).toBe(false);
  });

  it('classifies normalized conversation imports without traversing raw export fields', () => {
    const conversation = {
      title: 'imported title',
      promptPrefix: 'imported prefix',
      system: 'imported system',
      context: 'imported context',
      greeting: 'imported greeting',
      examples: [
        {
          input: { content: 'imported example input' },
          output: { content: 'imported example output' },
        },
      ],
      instructions: 'imported instructions',
      additional_instructions: 'imported additional instructions',
      artifacts: 'imported artifact guidance',
      stop: ['imported stop sequence'],
      additionalModelRequestFields: {
        thinking: { mode: 'imported request field' },
      },
      options: {
        response_format: {
          json_schema: { description: 'imported response format' },
        },
        metadata: { label: 'imported model metadata' },
      },
      presetOverride: {
        title: 'override title',
        promptPrefix: 'override prefix',
      },
      ignoredRawField: 'must not be traversed',
    };
    const fragments = fieldValues(
      Array.from(
        extractConversationImportContent({
          conversations: [conversation],
          messages: [
            {
              sender: 'imported sender',
              text: 'imported message',
              summary: 'imported message summary',
              feedback: { text: 'imported feedback' },
              content: [{ tool_call: { arguments: { token: 'imported tool argument' } } }],
            },
          ],
        }),
      ),
    );

    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'conversation_title',
          field: 'title',
          text: 'imported title',
        }),
        expect.objectContaining({
          source: 'prompt',
          field: 'preset_text',
          text: 'imported prefix',
        }),
        expect.objectContaining({
          source: 'agent_instruction',
          field: 'instructions',
          text: 'imported instructions',
        }),
        expect.objectContaining({
          source: 'prompt',
          field: 'name',
          text: 'override title',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'name',
          text: 'imported sender',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'summary',
          text: 'imported message summary',
        }),
        expect.objectContaining({
          source: 'feedback',
          field: 'text',
          text: 'imported feedback',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: '{"token":"imported tool argument"}',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'stop',
          text: 'imported stop sequence',
          path: '/stop/0',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'request_fields',
          text: 'imported request field',
          path: '/additionalModelRequestFields/thinking/mode',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'response_format',
          text: 'imported response format',
          path: '/options/response_format/json_schema/description',
        }),
        expect.objectContaining({
          source: 'model_parameter',
          field: 'metadata',
          text: 'imported model metadata',
          path: '/options/metadata/label',
        }),
      ]),
    );
    expect(fragments.some(({ text }) => text === 'must not be traversed')).toBe(false);
  });

  it('applies file-only rules to stored-message and imported attachment names', () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['name'],
          starterPatterns: [],
          customPatterns: [
            { id: 'private-file', label: 'private file', regex: 'PRIVATE-[A-Z]+\\.txt' },
          ],
        },
      },
    };
    const message = { attachments: [{ filename: 'PRIVATE-REPORT.txt' }] };

    expect(inspectContent(extractStoredMessageContent(message), { filters })).toMatchObject({
      source: 'file',
      field: 'name',
    });
    expect(
      inspectContent(extractConversationImportContent({ conversations: [], messages: [message] }), {
        filters,
      }),
    ).toMatchObject({
      source: 'file',
      field: 'name',
    });
  });

  it('safely serializes independent tool arguments and traverses cyclic values', () => {
    const cyclic: { protectedValue: string; self?: object } = {
      protectedValue: 'ORG-CYCLIC',
    };
    cyclic.self = cyclic;

    expect(
      fieldValues(
        extractToolArgumentContent({
          name: 'ORG-TOOL',
          arguments: { token: 'ORG-ARGS' },
          output: 'ORG-OUTPUT',
        }),
      ),
    ).toEqual([
      {
        source: 'tool_argument',
        field: 'name',
        text: 'ORG-TOOL',
        path: '/name',
      },
      {
        source: 'tool_argument',
        field: 'arguments',
        text: '{"token":"ORG-ARGS"}',
        path: '/arguments',
      },
      {
        source: 'tool_argument',
        field: 'output',
        text: 'ORG-OUTPUT',
        path: '/output',
      },
    ]);
    expect(extractToolArgumentContent({ arguments: cyclic })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'protectedValue',
          path: '/arguments/protectedValue',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-CYCLIC',
          path: '/arguments/protectedValue',
        }),
      ]),
    );
  });

  it.each([
    {
      label: 'quotes',
      first: 'VISIBLE-STORED-PREFIX',
      build: (values: readonly unknown[]) => ({ quotes: values }),
    },
    {
      label: 'top-level content',
      first: { text: 'VISIBLE-STORED-PREFIX' },
      build: (values: readonly unknown[]) => ({ content: values }),
    },
    {
      label: 'nested part content',
      first: { text: 'VISIBLE-STORED-PREFIX' },
      build: (values: readonly unknown[]) => ({ content: [{ content: values }] }),
    },
    {
      label: 'part files',
      first: { filename: 'VISIBLE-STORED-PREFIX' },
      build: (values: readonly unknown[]) => ({ content: [{ files: values }] }),
    },
    {
      label: 'top-level tool calls',
      first: { arguments: 'VISIBLE-STORED-PREFIX' },
      build: (values: readonly unknown[]) => ({ tool_calls: values }),
    },
    {
      label: 'top-level files',
      first: { filename: 'VISIBLE-STORED-PREFIX' },
      build: (values: readonly unknown[]) => ({ files: values }),
    },
    {
      label: 'top-level attachments',
      first: { filename: 'VISIBLE-STORED-PREFIX' },
      build: (values: readonly unknown[]) => ({ attachments: values }),
    },
  ])(
    'bounds $label without iterator dispatch and preserves prefix fragments',
    ({ first, build }) => {
      let lengthReads = 0;
      let numericReads = 0;
      let iteratorReads = 0;
      const target = new Array<unknown>(10_000_000);
      target[0] = first;
      const values = new Proxy(target, {
        get(array, property, receiver) {
          if (property === 'length') {
            lengthReads++;
          } else if (property === Symbol.iterator) {
            iteratorReads++;
          } else if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
            numericReads++;
          }
          return Reflect.get(array, property, receiver);
        },
      });

      let traversalError: ContentTraversalLimitError | null = null;
      try {
        extractStoredMessageContent(
          build(values) as NonNullable<Parameters<typeof extractStoredMessageContent>[0]>,
        );
      } catch (error) {
        if (!(error instanceof ContentTraversalLimitError)) {
          throw error;
        }
        traversalError = error;
      }

      expect(traversalError).toBeInstanceOf(ContentTraversalLimitError);
      expect(lengthReads).toBe(1);
      expect(numericReads).toBeLessThanOrEqual(CONTENT_TRAVERSAL_MAX_NODES);
      expect(iteratorReads).toBe(0);
      expect(
        getContentTraversalFragments(traversalError as ContentTraversalLimitError).some(
          ({ text }) => text === 'VISIBLE-STORED-PREFIX',
        ),
      ).toBe(true);
    },
  );

  it.each([
    (value: unknown) => ({ quotes: value }),
    (value: unknown) => ({ content: value }),
    (value: unknown) => ({ content: [{ content: value }] }),
    (value: unknown) => ({ content: [{ files: value }] }),
    (value: unknown) => ({ tool_calls: value }),
    (value: unknown) => ({ files: value }),
    (value: unknown) => ({ attachments: value }),
  ])('fails closed for malformed non-array stored-message carriers', (build) => {
    expect(() =>
      extractStoredMessageContent(
        build({ 0: 'uninspectable', length: 1 }) as NonNullable<
          Parameters<typeof extractStoredMessageContent>[0]
        >,
      ),
    ).toThrow(ContentTraversalLimitError);
  });

  it('preserves the 4,096 nested content-child boundary without duplicate accounting', () => {
    const createMessage = (length: number) => ({
      content: [
        {
          content: Array.from({ length }, (_, index) => ({ text: `safe-child-${index}` })),
        },
      ],
    });

    expect(() =>
      extractStoredMessageContent(createMessage(CONTENT_TRAVERSAL_MAX_NODES), {
        visitedNodes: 0,
        maxNodes: CONTENT_TRAVERSAL_MAX_NODES + 2,
      }),
    ).not.toThrow();
    expect(() =>
      extractStoredMessageContent(createMessage(CONTENT_TRAVERSAL_MAX_NODES + 1), {
        visitedNodes: 0,
        maxNodes: CONTENT_TRAVERSAL_MAX_NODES + 2,
      }),
    ).toThrow(ContentTraversalLimitError);
  });

  it.each([
    {
      label: 'agent conversation starters',
      first: 'VISIBLE-CRUD-PREFIX',
      extract: (values: readonly unknown[]) =>
        extractAgentContent({
          conversation_starters: values as NonNullable<
            Parameters<typeof extractAgentContent>[0]
          >['conversation_starters'],
        }),
    },
    {
      label: 'agent edges',
      first: { prompt: 'VISIBLE-CRUD-PREFIX' },
      extract: (values: readonly unknown[]) =>
        extractAgentContent({
          edges: values as NonNullable<Parameters<typeof extractAgentContent>[0]>['edges'],
        }),
    },
    {
      label: 'agent tool definitions',
      first: { name: 'VISIBLE-CRUD-PREFIX' },
      extract: (values: readonly unknown[]) =>
        extractAgentContent({
          toolDefinitions: values as NonNullable<
            Parameters<typeof extractAgentContent>[0]
          >['toolDefinitions'],
        }),
    },
    {
      label: 'preset examples',
      first: { input: 'VISIBLE-CRUD-PREFIX' },
      extract: (values: readonly unknown[]) =>
        extractPresetContent({
          examples: values as NonNullable<Parameters<typeof extractPresetContent>[0]>['examples'],
        }),
    },
    {
      label: 'skill files',
      first: { text: 'VISIBLE-CRUD-PREFIX' },
      extract: (values: readonly unknown[]) =>
        extractSkillContent({
          files: values as NonNullable<Parameters<typeof extractSkillContent>[0]>['files'],
        }),
    },
  ])('bounds sparse $label arrays', ({ first, extract }) => {
    let lengthReads = 0;
    let numericReads = 0;
    let iteratorReads = 0;
    const target = new Array<unknown>(10_000_000);
    target[0] = first;
    const values = new Proxy(target, {
      get(array, property, receiver) {
        if (property === 'length') {
          lengthReads++;
        } else if (property === Symbol.iterator) {
          iteratorReads++;
        } else if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
          numericReads++;
        }
        return Reflect.get(array, property, receiver);
      },
    });

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extract(values);
    } catch (error) {
      if (!(error instanceof ContentTraversalLimitError)) {
        throw error;
      }
      traversalError = error;
    }

    expect(traversalError).toBeInstanceOf(ContentTraversalLimitError);
    expect(lengthReads).toBe(1);
    expect(numericReads).toBeLessThanOrEqual(CONTENT_TRAVERSAL_MAX_NODES);
    expect(iteratorReads).toBe(0);
    expect(
      getContentTraversalFragments(traversalError as ContentTraversalLimitError).some(
        ({ text }) => text === 'VISIBLE-CRUD-PREFIX',
      ),
    ).toBe(true);
  });

  it('continues preset model-parameter extraction after prompt traversal overflow', () => {
    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractPresetContent({
        examples: Array.from({ length: CONTENT_TRAVERSAL_MAX_NODES + 1 }, () => ({
          input: 'Safe input',
          output: 'Safe output',
        })),
        options: { routing: 'PRIVATE-MODEL-PARAMETER' },
      });
    } catch (error) {
      if (!(error instanceof ContentTraversalLimitError)) {
        throw error;
      }
      traversalError = error;
    }

    expect(getContentTraversalScopes(traversalError as ContentTraversalLimitError)).toContainEqual({
      source: 'prompt',
      fields: ['example_input', 'example_output'],
    });
    expect(
      getContentTraversalFragments(traversalError as ContentTraversalLimitError),
    ).toContainEqual(
      expect.objectContaining({
        source: 'model_parameter',
        field: 'request_fields',
        text: 'PRIVATE-MODEL-PARAMETER',
      }),
    );
  });

  it('bounds normal acyclic tool serialization before reading deeper values', () => {
    interface NestedArguments {
      nested?: NestedArguments;
    }

    const argumentsValue: NestedArguments & { visible: string } = {
      visible: 'ORG-VISIBLE-ARGUMENT',
    };
    let current: NestedArguments = argumentsValue;
    for (let depth = 0; depth < CONTENT_TRAVERSAL_MAX_DEPTH; depth++) {
      current.nested = {};
      current = current.nested;
    }
    let overflowValueRead = false;
    const overflow: Record<string, unknown> = {};
    Object.defineProperty(overflow, 'protected_value', {
      enumerable: true,
      get() {
        overflowValueRead = true;
        return 'ORG-OVERFLOW-ARGUMENT';
      },
    });
    current.nested = overflow;

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractToolArgumentContent({ arguments: argumentsValue });
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    const error = traversalError as ContentTraversalLimitError;
    expect(getContentTraversalScopes(error)).toEqual([
      { source: 'tool_argument', fields: ['arguments'] },
    ]);
    expect(getContentTraversalFragments(error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-VISIBLE-ARGUMENT',
          path: '/arguments/visible',
        }),
      ]),
    );
    expect(overflowValueRead).toBe(false);
  });

  it('does not serialize normal tool properties beyond the shared node budget', () => {
    const argumentsValue = Object.fromEntries(
      Array.from({ length: CONTENT_TRAVERSAL_MAX_NODES - 1 }, (_, index) => [
        `field_${index}`,
        'safe',
      ]),
    );
    let overflowValueRead = false;
    Object.defineProperty(argumentsValue, 'overflow_value', {
      enumerable: true,
      get() {
        overflowValueRead = true;
        return 'ORG-OVERFLOW-ARGUMENT';
      },
    });

    expect(() => extractToolArgumentContent({ arguments: argumentsValue })).toThrow(
      ContentTraversalLimitError,
    );
    expect(overflowValueRead).toBe(false);
  });

  it('traverses cyclic stored tool arguments and preserves their message paths', () => {
    const cyclic: { protectedValue: string; self?: object } = {
      protectedValue: 'ORG-STORED-CYCLIC',
    };
    cyclic.self = cyclic;

    expect(
      extractStoredMessageContent({
        role: 'assistant',
        tool_calls: [{ arguments: cyclic }],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'protectedValue',
          path: '/tool_calls/0/arguments/protectedValue',
        }),
        expect.objectContaining({
          source: 'tool_argument',
          field: 'arguments',
          text: 'ORG-STORED-CYCLIC',
          path: '/tool_calls/0/arguments/protectedValue',
        }),
      ]),
    );
  });

  it('fails closed only for the selected field when stored tool traversal is incomplete', () => {
    interface DeepArguments {
      nested?: DeepArguments;
    }
    const argumentsValue: DeepArguments = {};
    let current = argumentsValue;
    for (let depth = 0; depth < 30; depth++) {
      current.nested = {};
      current = current.nested;
    }
    Object.defineProperty(argumentsValue, 'toJSON', {
      value: () => {
        throw new Error('cannot serialize');
      },
    });

    let traversalError: ContentTraversalLimitError | null = null;
    try {
      extractStoredMessageContent({
        role: 'assistant',
        original: 'later message content',
        tool_calls: [{ arguments: argumentsValue }],
      });
    } catch (error) {
      if (error instanceof ContentTraversalLimitError) {
        traversalError = error;
      } else {
        throw error;
      }
    }

    const error = traversalError as ContentTraversalLimitError;
    expect(getContentTraversalScopes(error)).toEqual([
      { source: 'tool_argument', fields: ['arguments'] },
    ]);
    expect(getContentTraversalFragments(error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'message',
          field: 'content_part',
          text: 'later message content',
        }),
      ]),
    );
    expect(
      isContentTraversalProtected({
        error,
        filters: {
          toolArguments: {
            pii: { fields: ['arguments'], starterPatterns: ['sk_prefix'] },
          },
        },
      }),
    ).toBe(true);
    expect(
      isContentTraversalProtected({
        error,
        filters: {
          toolArguments: {
            pii: { fields: ['output'], starterPatterns: ['sk_prefix'] },
          },
        },
      }),
    ).toBe(false);
    expect(isContentTraversalProtected({ error })).toBe(false);
  });

  it('fails closed when a non-serializable tool value cannot be fully traversed', () => {
    const throwing = new Proxy(
      { protectedValue: 'ORG-HIDDEN' },
      {
        ownKeys: () => {
          throw new Error('opaque');
        },
      },
    );

    expect(() => extractToolArgumentContent({ output: throwing })).toThrow(
      ContentTraversalLimitError,
    );
  });
});
