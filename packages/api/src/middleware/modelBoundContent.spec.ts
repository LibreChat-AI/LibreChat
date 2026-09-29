import { logger } from '@librechat/data-schemas';
import { StreamLimitExceededError } from '@librechat/agents';
import type { FiltersConfig } from 'librechat-data-provider';
import {
  assertModelBoundContent,
  assertModelBoundProviderContent,
  collectModelBoundHistoricalFileIdState,
  collectModelBoundHistoricalFileIds,
  createModelBoundChatModelCallback,
  createInitialModelBoundAdmissionCallback,
  hasModelBoundContentProtection,
  projectModelBoundSourceFiles,
} from './modelBoundContent';
import { isContentFilterError } from './contentFilter';

const filters: FiltersConfig = {
  messages: {
    pii: {
      fields: ['text'],
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    },
  },
};

const makeTraversalOverflowContent = () => [
  {
    type: 'custom',
    payload: Array.from({ length: 4_200 }, (_, index) => `safe-value-${index}`),
  },
];

const makeDeepModelParameter = () => {
  let value: unknown = 'safe';
  for (let depth = 0; depth < 30; depth++) {
    value = { nested: value };
  }
  return value;
};

const makeIncompleteAudioCarrier = () => {
  const carrier: Record<string, unknown> = {};
  Object.defineProperty(carrier, 'blocked', {
    enumerable: true,
    get() {
      throw new Error('snapshot blocked');
    },
  });
  carrier.input_audio = { data: 'opaque-audio', format: 'mp3' };
  return carrier;
};

describe('hasModelBoundContentProtection', () => {
  it.each([
    undefined,
    { prompts: { pii: {} } },
    { conversationTitles: { pii: {} } },
    { feedback: { pii: {} } },
    {
      messages: {
        pii: { starterPatterns: [] },
        unattributedAssistantContent: 'inspect' as const,
      },
    },
  ])('does not activate for management-only or inert config %#', (candidate) => {
    expect(hasModelBoundContentProtection(candidate)).toBe(false);
  });

  it.each([
    'messages',
    'agentInstructions',
    'conversationStarters',
    'skills',
    'memories',
    'toolArguments',
    'modelParameters',
    'actionMetadata',
  ] as const)('activates for the %s source', (source) => {
    expect(
      hasModelBoundContentProtection({
        [source]: { pii: {} },
      }),
    ).toBe(true);
  });

  it('activates for legacy patterns and fail-close file inspection', () => {
    expect(hasModelBoundContentProtection(undefined, {})).toBe(true);
    expect(
      hasModelBoundContentProtection({
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            uninspectable: 'block',
          },
        },
      }),
    ).toBe(true);
  });
});

describe('assertModelBoundContent', () => {
  it('records later audit findings before returning an earlier blocking finding', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);

    try {
      expect(() =>
        assertModelBoundContent({
          legacyPii: {
            starterPatterns: [],
            customPatterns: [{ id: 'legacy-block', label: 'legacy block', regex: 'PRIVATE-BLOCK' }],
          },
          filters: {
            skills: {
              pii: {
                action: 'audit',
                fields: ['instructions'],
                starterPatterns: [],
                customPatterns: [
                  { id: 'skill-audit', label: 'skill audit', regex: 'AUDIT-SECRET' },
                ],
              },
            },
          },
          submittedMessages: [{ role: 'user', content: 'PRIVATE-BLOCK' }],
          skills: [{ body: 'AUDIT-SECRET' }],
        }),
      ).toThrow('Submitted content contains a legacy block');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"ruleId":"skill-audit"'),
        expect.objectContaining({ action: 'audit', source: 'skill' }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('does not traverse model-bound content for a zero-rule configuration', () => {
    const message = {
      isCreatedByUser: true,
      get text(): string {
        throw new Error('model-bound extraction should be bypassed');
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: {
          skills: {
            pii: {
              fields: ['file_text'],
              starterPatterns: [],
            },
          },
        },
        storedMessages: [message],
      }),
    ).not.toThrow();
  });

  it('blocks persisted model-bound messages after a policy is enabled', () => {
    expect(() =>
      assertModelBoundContent({
        filters,
        storedMessages: [
          {
            isCreatedByUser: true,
            role: 'user',
            text: 'Previously stored PRIVATE-VALUE',
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('blocks assistant-role prose that was previously submitted by a user', () => {
    expect(() =>
      assertModelBoundContent({
        filters,
        storedMessages: [
          {
            isCreatedByUser: false,
            isUserSubmitted: true,
            role: 'assistant',
            text: 'Imported before policy enablement: PRIVATE-VALUE',
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('inspects only marked user-authored fields in a mixed assistant response', () => {
    const mixedFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['text', 'content_part'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
        },
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: mixedFilters,
        storedMessages: [
          {
            isCreatedByUser: false,
            text: 'Model generated PRIVATE-MODEL',
            content: [{ type: 'text', text: 'User edited PRIVATE-USER' }],
            userSubmittedPaths: ['/content/0/text'],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');

    expect(() =>
      assertModelBoundContent({
        filters: mixedFilters,
        storedMessages: [
          {
            isCreatedByUser: false,
            text: 'Model generated PRIVATE-MODEL',
            content: [{ type: 'text', text: 'Safe user edit' }],
            userSubmittedPaths: ['/content/0/text'],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('assembles only marked user-authored leaves in a mixed assistant response', () => {
    const assembledFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['assembled_context'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-VALUE' }],
        },
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: assembledFilters,
        storedMessages: [
          {
            isCreatedByUser: false,
            content: [
              { type: 'text', text: 'Model generated PRIVATE-MODEL' },
              { type: 'text', text: 'PRIVATE-' },
              { type: 'text', text: 'VALUE' },
            ],
            userSubmittedPaths: ['/content/1/text', '/content/2/text'],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');

    expect(() =>
      assertModelBoundContent({
        filters: assembledFilters,
        storedMessages: [
          {
            isCreatedByUser: false,
            content: [
              { type: 'text', text: 'PRIVATE-' },
              { type: 'text', text: 'VALUE' },
              { type: 'text', text: 'Safe user edit' },
            ],
            userSubmittedPaths: ['/content/2/text'],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('applies legacy-only rules across adjacent persisted submitted content parts', () => {
    expect(() =>
      assertModelBoundContent({
        legacyPii: {
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-VALUE' }],
        },
        storedMessages: [
          {
            isCreatedByUser: false,
            content: [
              { type: 'text', text: 'Model output' },
              { type: 'text', text: 'PRIVATE-' },
              { type: 'text', text: 'VALUE' },
            ],
            userSubmittedPaths: ['/content/1/text', '/content/2/text'],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('treats persisted steer parts as user-submitted without classifying neighboring model prose', () => {
    const mixedFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
        },
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: mixedFilters,
        storedMessages: [
          {
            isCreatedByUser: false,
            content: [
              { type: 'text', text: 'Model generated PRIVATE-MODEL' },
              { type: 'steer', steer: 'User supplied PRIVATE-STEER' },
            ],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');

    expect(() =>
      assertModelBoundContent({
        filters: mixedFilters,
        storedMessages: [
          {
            isCreatedByUser: false,
            content: [
              { type: 'text', text: 'Model generated PRIVATE-MODEL' },
              { type: 'steer', steer: 'Safe steer' },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('keeps legacy generic HITL provenance compatible with content_part policy', () => {
    const hitlMessage = {
      isCreatedByUser: false,
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: 'approval-1',
            args: 'PRIVATE-EDITED-ARGUMENT',
            output: 'PRIVATE-HUMAN-RESPONSE',
          },
        },
      ],
    };
    const messageFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [
            { id: 'private', label: 'private value', regex: 'PRIVATE-HUMAN-[A-Z]+' },
          ],
        },
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: messageFilters,
        storedMessages: [
          {
            ...hitlMessage,
            userSubmittedPaths: ['/content/0/tool_call/output'],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');

    expect(() =>
      assertModelBoundContent({
        filters: messageFilters,
        storedMessages: [
          {
            ...hitlMessage,
            userSubmittedPaths: ['/content/0/tool_call/args'],
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    {
      field: 'answer' as const,
      selectedIndex: 0,
      siblingIndex: 1,
    },
    {
      field: 'decision_response' as const,
      selectedIndex: 1,
      siblingIndex: 2,
    },
    {
      field: 'decision_reason' as const,
      selectedIndex: 2,
      siblingIndex: 0,
    },
  ])(
    'restores exact persisted $field policy without blocking sibling HITL fields',
    ({ field, selectedIndex, siblingIndex }) => {
      const semanticFields = ['answer', 'decision_response', 'decision_reason'] as const;
      const makeMessage = (privateIndex: number) => ({
        isCreatedByUser: false,
        role: 'assistant',
        content: semanticFields.map((semanticField, index) => ({
          type: 'tool_call',
          tool_call: {
            output: index === privateIndex ? 'PRIVATE-HITL' : `safe-${semanticField}`,
          },
        })),
        userSubmittedMessageFieldPaths: semanticFields.map((semanticField, index) => ({
          path: `/content/${index}/tool_call/output`,
          field: semanticField,
        })),
      });
      const fieldFilters: FiltersConfig = {
        messages: {
          pii: {
            fields: [field],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-HITL' }],
          },
        },
      };

      expect(() =>
        assertModelBoundContent({
          filters: fieldFilters,
          storedMessages: [makeMessage(selectedIndex)],
        }),
      ).toThrow('Submitted content contains a private value');

      expect(() =>
        assertModelBoundContent({
          filters: fieldFilters,
          storedMessages: [makeMessage(siblingIndex)],
        }),
      ).not.toThrow();
    },
  );

  it('does not reclassify exact persisted HITL fields as content_part or assembled_context', () => {
    const semanticMessage = {
      isCreatedByUser: false,
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          tool_call: { output: 'PRIVATE-HITL' },
        },
      ],
      userSubmittedMessageFieldPaths: [
        { path: '/content/0/tool_call/output', field: 'answer' as const },
      ],
    };
    const genericFilters = (field: 'content_part' | 'assembled_context'): FiltersConfig => ({
      messages: {
        pii: {
          fields: [field],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-HITL' }],
        },
      },
    });

    expect(() =>
      assertModelBoundContent({
        filters: genericFilters('content_part'),
        storedMessages: [semanticMessage],
      }),
    ).not.toThrow();
    expect(() =>
      assertModelBoundContent({
        filters: genericFilters('assembled_context'),
        storedMessages: [semanticMessage],
      }),
    ).not.toThrow();
  });

  it('fails closed for uninspectable exact persisted HITL content under legacy policy', () => {
    expect(() =>
      assertModelBoundContent({
        legacyPii: {
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-HITL' }],
        },
        storedMessages: [
          {
            isCreatedByUser: false,
            role: 'assistant',
            content: makeTraversalOverflowContent(),
            userSubmittedMessageFieldPaths: [{ path: '/content/0', field: 'answer' }],
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('fails closed only when the uninspectable exact HITL field is selected', () => {
    const makeFilters = (field: 'answer' | 'decision_reason'): FiltersConfig => ({
      messages: {
        pii: {
          fields: [field],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-HITL' }],
        },
      },
    });
    const storedMessages = [
      {
        isCreatedByUser: false,
        role: 'assistant',
        content: makeTraversalOverflowContent(),
        userSubmittedMessageFieldPaths: [{ path: '/content/0', field: 'answer' as const }],
      },
    ];

    expect(() =>
      assertModelBoundContent({ filters: makeFilters('answer'), storedMessages }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(() =>
      assertModelBoundContent({ filters: makeFilters('decision_reason'), storedMessages }),
    ).not.toThrow();
  });

  it('retains toolArguments.output coverage for exact persisted HITL fields', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['output'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-HITL' }],
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: false,
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                tool_call: { output: 'PRIVATE-HITL' },
              },
            ],
            userSubmittedMessageFieldPaths: [
              { path: '/content/0/tool_call/output', field: 'answer' },
            ],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('applies fail-close file policy only to marked fields in mixed assistant responses', () => {
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    const storedMessage = {
      isCreatedByUser: false,
      content: [
        { type: 'input_file', file_id: 'model-file' },
        { type: 'text', text: 'User-edited text' },
      ],
    };

    expect(() =>
      assertModelBoundContent({
        filters: fileFilters,
        storedMessages: [{ ...storedMessage, userSubmittedPaths: ['/content/1/text'] }],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters: fileFilters,
        storedMessages: [{ ...storedMessage, userSubmittedPaths: ['/content/0'] }],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');
  });

  it('fails safe by inspecting the full row when provenance paths exceed the bound', () => {
    const boundedPaths = Array.from({ length: 256 }, (_, index) => `/content/${index}/text`);
    const storedMessage = {
      isCreatedByUser: false,
      text: 'Model generated PRIVATE-MODEL',
    };

    expect(() =>
      assertModelBoundContent({
        filters,
        storedMessages: [{ ...storedMessage, userSubmittedPaths: boundedPaths }],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters,
        storedMessages: [
          {
            ...storedMessage,
            userSubmittedPaths: [...boundedPaths, '/content/256/text'],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it.each([
    {
      name: 'legacy unmarked assistant prose',
      message: {
        isCreatedByUser: false,
        role: 'assistant',
        text: 'Legacy model output PRIVATE-VALUE',
      },
    },
    {
      name: 'explicitly model-authored assistant prose',
      message: {
        isCreatedByUser: false,
        isUserSubmitted: false,
        role: 'assistant',
        text: 'Model generated PRIVATE-VALUE',
      },
    },
  ])('does not treat $name as user-submitted content', ({ message }) => {
    expect(() =>
      assertModelBoundContent({
        filters,
        storedMessages: [message],
      }),
    ).not.toThrow();
  });

  it('keeps explicit model_output attribution compatible with omission', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          ...filters,
          messages: {
            ...filters.messages,
            unattributedAssistantContent: 'model_output',
          },
        },
        storedMessages: [
          {
            isCreatedByUser: false,
            role: 'assistant',
            text: 'Legacy model output PRIVATE-VALUE',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('inspects unattributed assistant rows when strict legacy attribution is enabled', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          ...filters,
          messages: {
            ...filters.messages,
            unattributedAssistantContent: 'inspect',
          },
        },
        storedMessages: [
          {
            isCreatedByUser: false,
            role: 'assistant',
            text: 'Legacy unattributed PRIVATE-VALUE',
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('recognizes an assistant role as unattributed even without an author flag', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          ...filters,
          messages: {
            ...filters.messages,
            unattributedAssistantContent: 'inspect',
          },
        },
        storedMessages: [
          {
            role: 'assistant',
            text: 'Legacy unattributed PRIVATE-VALUE',
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('honors explicit model attribution and path-scoped user attribution in strict mode', () => {
    const strictFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['text', 'content_part'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
        },
        unattributedAssistantContent: 'inspect',
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: strictFilters,
        storedMessages: [
          {
            isCreatedByUser: false,
            isUserSubmitted: false,
            role: 'assistant',
            text: 'Explicit model output PRIVATE-VALUE',
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters: strictFilters,
        storedMessages: [
          {
            isCreatedByUser: false,
            isUserSubmitted: false,
            role: 'assistant',
            text: 'Model output PRIVATE-MODEL',
            content: [{ type: 'text', text: 'Safe user edit' }],
            userSubmittedPaths: ['/content/0/text'],
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters: strictFilters,
        storedMessages: [
          {
            isCreatedByUser: false,
            role: 'assistant',
            text: 'Model output PRIVATE-MODEL',
            content: [
              { type: 'text', text: 'Model content' },
              { type: 'steer', steer: 'Safe user steer' },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each(['not-a-json-pointer', '/missing', '/messageId', '/__proto__/polluted'])(
    'treats ineffective provenance path %s as unattributed in strict mode',
    (userSubmittedPath) => {
      expect(() =>
        assertModelBoundContent({
          filters: {
            ...filters,
            messages: {
              ...filters.messages,
              unattributedAssistantContent: 'inspect',
            },
          },
          storedMessages: [
            {
              isCreatedByUser: false,
              role: 'assistant',
              messageId: 'legacy-message',
              text: 'Legacy unattributed PRIVATE-VALUE',
              userSubmittedPaths: [userSubmittedPath],
            },
          ],
        }),
      ).toThrow('Submitted content contains a private value');
    },
  );

  it('re-inspects structured historical tool output without treating assistant prose as a message', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['text'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-PROSE' }],
            },
          },
          toolArguments: {
            pii: {
              fields: ['output'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-TOOL' }],
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: false,
            role: 'assistant',
            text: 'Model generated PRIVATE-PROSE',
          },
          {
            isCreatedByUser: false,
            role: 'tool',
            text: 'Historical PRIVATE-TOOL result',
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('preserves source granularity for reusable contexts', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          memories: {
            pii: {
              fields: ['value'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        memories: ['Previously stored PRIVATE-MEMORY'],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('does not classify skill content as a message', () => {
    expect(() =>
      assertModelBoundContent({
        filters,
        skills: [{ name: 'private-skill', body: 'PRIVATE-VALUE' }],
      }),
    ).not.toThrow();
  });

  it('applies a newly enabled fail-close file policy to persisted user references', () => {
    const historicalMessage = {
      isCreatedByUser: true,
      role: 'user',
      content: [{ type: 'input_file', file_id: 'file-historical' }],
    };

    expect(() =>
      assertModelBoundContent({
        storedMessages: [historicalMessage],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        storedMessages: [historicalMessage],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');
  });

  it('accepts stored file locators only when backed by inspectable owner-resolved rows', () => {
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    const historicalMessage = {
      isCreatedByUser: true,
      role: 'user',
      files: [{ file_id: 'file-owned' }, { file_id: 'file-missing' }],
    };
    const ownedFile = {
      file_id: 'file-owned',
      filename: 'owned.txt',
      filepath: '/uploads/owned.txt',
      text: 'safe canonical content',
    };

    expect(() =>
      assertModelBoundContent({
        filters: fileFilters,
        storedMessages: [{ ...historicalMessage, files: [{ file_id: 'file-owned' }] }],
        resolvedFiles: [ownedFile],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters: fileFilters,
        storedMessages: [historicalMessage],
        resolvedFiles: [ownedFile],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');
  });

  it('retains own __proto__ file locators while omitting owner-resolved references', () => {
    const storedMessage = JSON.parse(
      '{"isCreatedByUser":true,"role":"user","files":[{"file_id":"file-owned"}],"__proto__":{"file_id":"file-opaque"}}',
    );

    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        storedMessages: [storedMessage],
        resolvedFiles: [
          {
            file_id: 'file-owned',
            filename: 'owned.txt',
            filepath: '/uploads/owned.txt',
            text: 'safe canonical content',
          },
        ],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');
  });

  it('accepts a submitted locator only when it exactly matches the owner-resolved row', () => {
    const canonicalFile = {
      file_id: 'file-owned',
      filename: 'owned.txt',
      filepath: '/uploads/owned.txt',
      text: 'safe canonical content',
    };

    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: true,
            role: 'user',
            files: [
              {
                file_id: canonicalFile.file_id,
                filepath: canonicalFile.filepath,
              },
            ],
          },
        ],
        resolvedFiles: [canonicalFile],
      }),
    ).not.toThrow();
  });

  it.each([
    ['remote uri', { uri: 'https://attacker.example/private.txt' }],
    ['remote url', { url: 'https://attacker.example/private.txt' }],
    ['relative url', { url: '/api/files/untrusted' }],
    ['remote filepath', { filepath: 'https://attacker.example/private.txt' }],
    ['remote preview', { preview: 'https://attacker.example/private.txt' }],
    ['data URI', { uri: 'data:text/plain;base64,U0VDUkVU' }],
  ])('rejects an owned ID paired with a conflicting %s', (_name, locator) => {
    const canonicalFile = {
      file_id: 'file-owned',
      filename: 'owned.txt',
      filepath: '/uploads/owned.txt',
      type: 'text/plain',
      source: 'text',
      text: 'safe canonical content',
    };

    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: true,
            role: 'user',
            files: [{ file_id: canonicalFile.file_id, ...locator }],
          },
        ],
        resolvedFiles: [canonicalFile],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');
  });

  it.each([
    ['url', { url: 'https://attacker.example/PRIVATE-FILE.txt' }],
    ['relative url', { url: '/api/files/PRIVATE-FILE.txt' }],
    ['preview', { preview: 'https://attacker.example/PRIVATE-FILE.txt' }],
  ])('inspects a conflicting %s alias in pattern mode', (_name, locator) => {
    const pattern = {
      starterPatterns: [],
      customPatterns: [
        {
          id: 'private-file',
          label: 'private file value',
          regex: 'PRIVATE-FILE',
        },
      ],
    };
    const policyVariants: FiltersConfig[] = [
      {
        files: {
          pii: {
            ...pattern,
            fields: ['uri'],
          },
        },
      },
      {
        messages: {
          pii: {
            ...pattern,
            fields: ['attachment_reference'],
          },
        },
      },
    ];

    for (const policy of policyVariants) {
      expect(() =>
        assertModelBoundContent({
          filters: policy,
          storedMessages: [
            {
              isCreatedByUser: true,
              role: 'user',
              files: [{ file_id: 'file-owned', ...locator }],
            },
          ],
          resolvedFiles: [
            {
              file_id: 'file-owned',
              filename: 'owned.txt',
              filepath: '/uploads/owned.txt',
              text: 'safe canonical content',
            },
          ],
        }),
      ).toThrow('Submitted content contains a private file value');
    }
  });

  it('preserves default allow behavior for a nonmatching conflicting locator', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['uri'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private-file',
                  label: 'private file value',
                  regex: 'PRIVATE-FILE',
                },
              ],
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: true,
            role: 'user',
            files: [
              {
                file_id: 'file-owned',
                url: 'https://attacker.example/public.txt',
              },
            ],
          },
        ],
        resolvedFiles: [
          {
            file_id: 'file-owned',
            filename: 'owned.txt',
            filepath: '/uploads/owned.txt',
            text: 'safe canonical content',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('inspects long stored history per message and still filters hydrated file content', () => {
    const onTraversalFailure = jest.fn();
    const storedMessages = Array.from({ length: 58 }, (_, index) => ({
      isCreatedByUser: true,
      role: 'user',
      text: `Historical step ${index}`,
      files: index === 0 ? [{ file_id: 'file-owned' }] : [],
      content: Array.from({ length: 80 }, () => ({ type: 'text', text: 'safe preview material' })),
    }));
    const input = {
      filters: {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-FILE' }],
            uninspectable: 'block',
          },
        },
      } as FiltersConfig,
      storedMessages,
      onTraversalFailure,
      resolvedFiles: [{ file_id: 'file-owned', text: 'safe canonical content' }],
    };

    expect(() => assertModelBoundContent(input)).not.toThrow();
    expect(() =>
      assertModelBoundContent({
        ...input,
        resolvedFiles: [{ file_id: 'file-owned', text: 'PRIVATE-FILE' }],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(() =>
      assertModelBoundContent({
        ...input,
        storedMessages: [
          { ...storedMessages[0], content: storedMessages.flatMap((m) => m.content) },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(onTraversalFailure).toHaveBeenCalledTimes(1);
    expect(onTraversalFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'omit_resolved_file_locators',
        reason: 'array_length',
        messageCount: 1,
        resolvedFileCount: 1,
      }),
    );
  });

  it('inspects owner-resolved file content before authorizing its stored locator', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private-file',
                  label: 'private file value',
                  regex: 'PRIVATE-FILE',
                },
              ],
              uninspectable: 'block',
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: true,
            role: 'user',
            files: [{ file_id: 'file-owned' }],
          },
        ],
        resolvedFiles: [
          {
            file_id: 'file-owned',
            filename: 'owned.txt',
            filepath: '/uploads/owned.txt',
            text: 'PRIVATE-FILE',
          },
        ],
      }),
    ).toThrow('Submitted content contains a private file value');
  });

  it('does not apply persisted-user policy to historical model output', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: false,
            role: 'assistant',
            content: [{ type: 'input_file', file_id: 'file-generated' }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('treats every role in a fresh API request as caller-submitted', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        submittedMessages: [
          {
            role: 'assistant',
            content: [{ type: 'input_file', file_id: 'file-caller-supplied' }],
          },
        ],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');
  });

  it('uses one stable submitted-part snapshot for file checks and content inspection', () => {
    let textReads = 0;
    const part = {
      type: 'text',
      get text() {
        textReads++;
        return textReads === 1 ? 'PRIVATE-SUBMITTED-CONTENT' : 'safe later value';
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private',
                  label: 'private value',
                  regex: 'PRIVATE-SUBMITTED-CONTENT',
                },
              ],
            },
          },
          files: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        submittedMessages: [{ role: 'user', content: [part] }],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(textReads).toBe(1);
  });

  it('uses one stable submitted file-wrapper snapshot across policy phases', () => {
    let filenameReads = 0;
    const file = {
      get filename() {
        filenameReads++;
        return filenameReads === 1 ? 'PRIVATE-SUBMITTED-FILE.txt' : 'safe.txt';
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private',
                  label: 'private file value',
                  regex: 'PRIVATE-SUBMITTED-FILE',
                },
              ],
              uninspectable: 'block',
            },
          },
        },
        submittedMessages: [{ role: 'user', content: [{ type: 'file', file }] }],
      }),
    ).toThrow('Submitted content contains a private file value');
    expect(filenameReads).toBe(1);
  });

  it('snapshots submitted message envelopes without enumerating irrelevant keys', () => {
    let roleReads = 0;
    let typeReads = 0;
    let typeCalls = 0;
    let contentReads = 0;
    let irrelevantReads = 0;
    const message = {
      get role() {
        roleReads++;
        return undefined;
      },
      get _getType() {
        typeReads++;
        return () => {
          typeCalls++;
          return 'human';
        };
      },
      get content() {
        contentReads++;
        return 'PRIVATE-SUBMITTED-ENVELOPE';
      },
      get irrelevant() {
        irrelevantReads++;
        return 'must not be enumerated';
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['text'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private',
                  label: 'private value',
                  regex: 'PRIVATE-SUBMITTED-ENVELOPE',
                },
              ],
            },
          },
        },
        submittedMessages: [message],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(roleReads).toBe(1);
    expect(typeReads).toBe(1);
    expect(typeCalls).toBe(1);
    expect(contentReads).toBe(1);
    expect(irrelevantReads).toBe(0);
  });

  it('bounds submitted message arrays numerically without dispatching their iterator', () => {
    let lengthReads = 0;
    let numericReads = 0;
    let iteratorReads = 0;
    const values = new Array<unknown>(10_000_000);
    values[0] = { role: 'user', content: 'PRIVATE-SUBMITTED-PREFIX' };
    const submittedMessages = new Proxy(values, {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
        } else if (property === Symbol.iterator) {
          iteratorReads++;
          throw new Error('submitted message iterator must not run');
        } else if (typeof property === 'string' && /^\d+$/.test(property)) {
          numericReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['text'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private',
                  label: 'private value',
                  regex: 'PRIVATE-SUBMITTED-PREFIX',
                },
              ],
            },
          },
        },
        submittedMessages: submittedMessages as never,
      }),
    ).toThrow('Submitted content contains a private value');
    expect(lengthReads).toBe(1);
    expect(numericReads).toBe(4_096);
    expect(iteratorReads).toBe(0);
  });

  it('allows 4,096 submitted parts under file-field inspection', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private file value', regex: 'PRIVATE-HIDDEN-FILE' },
              ],
            },
          },
        },
        submittedMessages: [{ role: 'user', content: new Array(4_096).fill(null) }],
      }),
    ).not.toThrow();
  });

  it.each([
    {
      label: 'active file-field patterns',
      pii: {
        fields: ['name'],
        starterPatterns: [],
        customPatterns: [
          { id: 'private', label: 'private file value', regex: 'PRIVATE-HIDDEN-FILE' },
        ],
      } as NonNullable<NonNullable<FiltersConfig['files']>['pii']>,
    },
    {
      label: 'strict uninspectable-file handling',
      pii: {
        fields: ['name'],
        starterPatterns: [],
        uninspectable: 'block',
      } as NonNullable<NonNullable<FiltersConfig['files']>['pii']>,
    },
  ])('fails closed for a hidden 4,097th submitted file part under $label', ({ pii }) => {
    const content = new Array<unknown>(4_097).fill(null);
    content[4_096] = { type: 'file', filename: 'PRIVATE-HIDDEN-FILE.txt' };

    expect(() =>
      assertModelBoundContent({
        filters: { files: { pii } },
        submittedMessages: [{ role: 'user', content: content as never }],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('fails closed when an incomplete submitted snapshot can hide an audio transcript', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['transcript'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        submittedMessages: [
          {
            role: 'user',
            content: [{ type: 'vendor_content', payload: makeIncompleteAudioCarrier() }],
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('blocks historical agent resource references and file records', () => {
    const failClosedFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: failClosedFilters,
        agents: [
          {
            tool_resources: {
              file_search: { vector_store_ids: ['vector-historical'] },
            },
          } as never,
        ],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');

    expect(() =>
      assertModelBoundContent({
        filters: failClosedFilters,
        files: [{ file_id: 'file-agent-context' } as never],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');

    expect(() =>
      assertModelBoundContent({
        filters: failClosedFilters,
        files: [
          {
            file_id: 'file-agent-context',
            filename: 'context.txt',
            filepath: '/uploads/context.txt',
            text: 'safe canonical context',
          } as never,
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private-context',
                  label: 'private context',
                  regex: 'PRIVATE-CONTEXT',
                },
              ],
              uninspectable: 'block',
            },
          },
        },
        files: [
          {
            file_id: 'file-agent-context',
            filename: 'context.txt',
            filepath: '/uploads/context.txt',
            text: 'PRIVATE-CONTEXT',
          } as never,
        ],
      }),
    ).toThrow('Submitted content contains a private context');
  });

  it('accepts only agent resource IDs backed by inspectable hydrated resource files', () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    const hydratedFile = {
      file_id: 'file-agent-context',
      filename: 'context.txt',
      filepath: '/uploads/context.txt',
      text: 'safe canonical context',
    };

    expect(() =>
      assertModelBoundContent({
        filters,
        agents: [
          {
            tool_resources: {
              context: {
                file_ids: ['file-agent-context'],
                files: [hydratedFile],
              },
            },
            agentContextAttachments: [hydratedFile],
          } as never,
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters,
        agents: [
          {
            tool_resources: {
              context: {
                file_ids: ['file-agent-context', 'unresolved-file'],
                files: [hydratedFile],
              },
            },
            agentContextAttachments: [hydratedFile],
          } as never,
        ],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');
  });

  it('does not let unrelated source policy or excluded file fields interfere', () => {
    const opaqueUserMessage = {
      isCreatedByUser: true,
      role: 'user',
      content: [{ type: 'input_file', file_id: 'file-opaque' }],
    };

    expect(() =>
      assertModelBoundContent({
        filters,
        storedMessages: [opaqueUserMessage],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters: {
          files: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        storedMessages: [opaqueUserMessage],
      }),
    ).not.toThrow();
  });

  it('does not fail a model-only row when nested model prose exceeds the traversal budget', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: false,
            role: 'assistant',
            content: makeTraversalOverflowContent(),
          },
        ],
      }),
    ).not.toThrow();
  });

  it('fails closed only for the selected uninspectable tool output on an assistant row', () => {
    const uninspectableOutput = new Proxy(
      { visible: 'safe' },
      {
        ownKeys() {
          throw new Error('opaque tool output');
        },
      },
    );
    const storedMessages = [
      {
        isCreatedByUser: false,
        role: 'assistant',
        tool_calls: [{ output: uninspectableOutput }],
      },
    ];

    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['output'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        storedMessages,
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');

    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        storedMessages,
      }),
    ).not.toThrow();
  });

  it('applies bounded skill and action errors only to their selected fields', () => {
    const createDeepValue = (visible: string): Record<string, unknown> => {
      const root: Record<string, unknown> = { visible };
      let current = root;
      for (let depth = 0; depth < 30; depth++) {
        const nested: Record<string, unknown> = {};
        current.nested = nested;
        current = nested;
      }
      return root;
    };
    const skill = { frontmatter: createDeepValue('visible skill value') };
    const action = { metadata: { raw_spec: createDeepValue('visible action value') } };

    expect(() =>
      assertModelBoundContent({
        filters: { skills: { pii: { fields: ['frontmatter'] } } },
        skills: [skill],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(() =>
      assertModelBoundContent({
        filters: { skills: { pii: { fields: ['instructions'] } } },
        skills: [skill],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        filters: { actionMetadata: { pii: { fields: ['raw_spec'] } } },
        actions: [action],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(() =>
      assertModelBoundContent({
        filters: { actionMetadata: { pii: { fields: ['domain'] } } },
        actions: [action],
      }),
    ).not.toThrow();

    const privatePattern = {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z-]+' }],
    };
    expect(() =>
      assertModelBoundContent({
        filters: { skills: { pii: { ...privatePattern, fields: ['file_text'] } } },
        skills: [
          {
            ...skill,
            files: [{ text: 'PRIVATE-SKILL-FILE' }],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(() =>
      assertModelBoundContent({
        filters: { actionMetadata: { pii: { ...privatePattern, fields: ['domain'] } } },
        actions: [
          {
            metadata: {
              raw_spec: action.metadata.raw_spec,
              domain: 'PRIVATE-ACTION-DOMAIN',
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('does not fail submitted message traversal for an unrelated source policy', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          conversationTitles: {
            pii: {
              fields: ['title'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: true,
            role: 'user',
            content: makeTraversalOverflowContent(),
          },
        ],
      }),
    ).not.toThrow();
  });

  it('fails closed when protected submitted message content exceeds the traversal budget', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: true,
            role: 'user',
            content: makeTraversalOverflowContent(),
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('shares one assembled-character budget across stored messages', () => {
    const traversalBudget = {
      visitedNodes: 0,
      maxNodes: 8_192,
      materializedCharacters: 0,
      maxMaterializedCharacters: 1_024,
    };
    const repeated = 'safe'.repeat(100);

    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['assembled_context'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-NEVER' }],
            },
          },
        },
        storedMessages: Array.from({ length: 128 }, () => ({
          role: 'user',
          isCreatedByUser: true,
          content: [
            { type: 'text', text: repeated },
            { type: 'text', text: repeated },
          ],
        })),
        traversalBudget,
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(traversalBudget.materializedCharacters).toBe(1_024);
  });

  it('allows submitted content-part inspection after only its aggregate overflows', () => {
    const part = 'safe'.repeat(250_000);

    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-NEVER' }],
            },
          },
        },
        submittedMessages: Array.from({ length: 5 }, () => ({
          role: 'user',
          content: [
            { type: 'text', text: part },
            { type: 'text', text: part },
          ],
        })),
      }),
    ).not.toThrow();
  });

  it('continues direct submitted-part inspection after aggregate materialization overflows', () => {
    const part = 'safe'.repeat(250_000);

    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-LATE' }],
            },
          },
        },
        submittedMessages: [
          ...Array.from({ length: 5 }, () => ({
            role: 'user',
            content: [
              { type: 'text', text: part },
              { type: 'text', text: part },
            ],
          })),
          { role: 'user', content: [{ type: 'text', text: 'PRIVATE-LATE' }] },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('fails closed for a tool-output aggregate that cannot be materialized', () => {
    const part = 'safe'.repeat(250_000);

    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['output'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-NEVER' }],
            },
          },
        },
        submittedMessages: Array.from({ length: 5 }, () => ({
          role: 'tool',
          content: [
            { type: 'text', text: part },
            { type: 'text', text: part },
          ],
        })),
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('accumulates later tool-output scope after an earlier aggregate overflow', () => {
    const part = 'safe'.repeat(250_000);

    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['output'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-NEVER' }],
            },
          },
        },
        submittedMessages: [
          ...Array.from({ length: 5 }, () => ({
            role: 'user',
            content: [
              { type: 'text', text: part },
              { type: 'text', text: part },
            ],
          })),
          {
            role: 'tool',
            content: [
              { type: 'text', text: part },
              { type: 'text', text: part },
            ],
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('bounds a second mixed-row aggregate while preserving a later direct finding', () => {
    const traversalBudget = {
      visitedNodes: 0,
      maxNodes: 8_192,
      materializedCharacters: 0,
      maxMaterializedCharacters: 20,
    };

    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part', 'assembled_context'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-LATE-FINDING' },
              ],
            },
          },
        },
        storedMessages: [
          {
            role: 'assistant',
            isCreatedByUser: false,
            content: [
              { type: 'text', text: '1234567890' },
              { type: 'text', text: 'abcdefghij' },
            ],
            userSubmittedPaths: ['/content/0/text', '/content/1/text'],
          },
          {
            role: 'user',
            isCreatedByUser: true,
            content: [{ type: 'text', text: 'PRIVATE-LATE-FINDING' }],
          },
        ],
        traversalBudget,
      }),
    ).toThrow('Submitted content contains a private value');
    expect(traversalBudget.materializedCharacters).toBe(20);
  });

  it('preserves a concrete finding before bounded manual nested-content overflow', () => {
    let lengthReads = 0;
    let numericReads = 0;
    let iteratorReads = 0;
    const target = new Array<{ text: string } | undefined>(10_000_000);
    target[0] = { text: 'PRIVATE-MANUAL-PREFIX' };
    const nestedContent = new Proxy(target, {
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

    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-MANUAL-PREFIX' },
              ],
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: true,
            role: 'user',
            content: [{ content: nestedContent }],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(lengthReads).toBe(1);
    expect(numericReads).toBeLessThanOrEqual(4_097);
    expect(iteratorReads).toBe(0);
  });

  it('still inspects structured tool arguments after overflowing model-only content', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        storedMessages: [
          {
            isCreatedByUser: false,
            role: 'assistant',
            content: makeTraversalOverflowContent(),
            tool_calls: [
              {
                function: {
                  name: 'submit',
                  arguments: '{"value":"PRIVATE-TOOL"}',
                },
              },
            ],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('still inspects submitted API tool arguments after overflowing nested content', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        submittedMessages: [
          {
            role: 'assistant',
            content: makeTraversalOverflowContent(),
            tool_calls: [
              {
                function: {
                  name: 'submit',
                  arguments: '{"value":"PRIVATE-TOOL"}',
                },
              },
            ],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('blocks initialized action schemas before they become model-bound', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        agents: [
          {
            toolDefinitions: [
              {
                name: 'submit_record',
                description: 'Submit a record',
                parameters: {
                  type: 'object',
                  properties: {
                    account: {
                      type: 'string',
                      description: 'Previously stored PRIVATE-SCHEMA',
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('preserves agent-instruction granularity for initialized tool descriptions', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          agentInstructions: {
            pii: {
              fields: ['description'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        agents: [
          {
            toolDefinitions: [
              {
                name: 'submit_record',
                description: 'Previously stored PRIVATE-DESCRIPTION',
                parameters: { type: 'object' },
              },
            ],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('fails closed for exhausted selected model request fields', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          modelParameters: {
            pii: {
              fields: ['request_fields'],
            },
          },
        },
        agents: [{ options: { provider_option: makeDeepModelParameter() } }],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('allows exhausted model request fields when only stop is selected', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          modelParameters: {
            pii: {
              fields: ['stop'],
            },
          },
        },
        agents: [{ options: { provider_option: makeDeepModelParameter() } }],
      }),
    ).not.toThrow();
  });

  it('fails closed when an exhausted wrapper chain could contain selected stop content', () => {
    let nested: unknown = { stop: 'PRIVATE-STOP' };
    for (let depth = 0; depth < 30; depth++) {
      nested = { options: nested };
    }

    expect(() =>
      assertModelBoundContent({
        filters: {
          modelParameters: {
            pii: {
              fields: ['stop'],
            },
          },
        },
        agents: [{ options: nested }],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('still inspects agent fields when unrelated model traversal is exhausted', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          agentInstructions: {
            pii: {
              fields: ['instructions'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        agents: [
          {
            instructions: 'Previously stored PRIVATE-INSTRUCTION',
            options: { provider_option: makeDeepModelParameter() },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('blocks persisted Assistant function schemas under current policy', () => {
    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        assistants: [
          {
            instructions: 'Safe instructions',
            tools: [
              {
                type: 'function',
                function: {
                  name: 'submit_record',
                  description: 'Submit a record',
                  parameters: {
                    type: 'object',
                    properties: {
                      value: {
                        type: 'string',
                        description: 'Previously stored PRIVATE-ASSISTANT-SCHEMA',
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('blocks persisted action metadata and schemas under current policy', () => {
    const action = {
      metadata: {
        domain: 'https://PRIVATE-DOMAIN.example',
        raw_spec: JSON.stringify({
          openapi: '3.0.3',
          paths: {
            '/records': {
              post: {
                operationId: 'submit_record',
                description: 'Previously stored PRIVATE-SCHEMA',
              },
            },
          },
        }),
      },
    };

    expect(() =>
      assertModelBoundContent({
        filters: {
          actionMetadata: {
            pii: {
              fields: ['domain'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        actions: [action],
      }),
    ).toThrow('Submitted content contains a private value');

    expect(() =>
      assertModelBoundContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        actions: [action],
      }),
    ).toThrow('Submitted content contains a private value');
  });
});

describe('assertModelBoundProviderContent', () => {
  it.each([
    {
      lineage: 'legacy',
      providerMessage: {
        role: 'assistant',
        content: 'Safe model derivative',
        additional_kwargs: { sourceMessageId: 'hitl-overflow' },
      },
    },
    {
      lineage: 'typed',
      providerMessage: {
        role: 'assistant',
        content: 'Safe model derivative',
        additional_kwargs: {
          provenance: {
            version: 1 as const,
            parts: [
              {
                attribution: 'model' as const,
                sourceMessageId: 'hitl-overflow',
                sourceContentPartIndices: [1],
              },
            ],
          },
        },
      },
    },
  ])(
    'scopes exact HITL provenance overflow away from unrelated policy for $lineage lineage',
    ({ providerMessage }) => {
      const userSubmittedMessageFieldPaths = Array.from({ length: 257 }, (_, index) => ({
        path: `/content/0/tool_call/output/${index}`,
        field: 'decision_response' as const,
      }));
      const storedMessages = [
        {
          messageId: 'hitl-overflow',
          isCreatedByUser: false,
          role: 'assistant',
          content: [
            { type: 'tool_call', tool_call: { output: 'Safe answer' } },
            { type: 'text', text: 'PRIVATE-MODEL-SIBLING' },
          ],
          userSubmittedMessageFieldPaths,
        },
      ];
      const providerMessages = [providerMessage];

      expect(() =>
        assertModelBoundProviderContent({
          filters: {
            files: {
              pii: {
                fields: ['name'],
                starterPatterns: [],
                customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-NEVER' }],
              },
            },
          },
          storedMessages,
          providerMessages,
        }),
      ).not.toThrow();

      expect(() =>
        assertModelBoundProviderContent({
          filters: {
            messages: {
              pii: {
                fields: ['content_part'],
                starterPatterns: [],
                customPatterns: [
                  { id: 'private', label: 'private', regex: 'PRIVATE-MODEL-SIBLING' },
                ],
              },
            },
          },
          storedMessages,
          providerMessages,
        }),
      ).not.toThrow();

      expect(() =>
        assertModelBoundProviderContent({
          filters: {
            messages: {
              pii: {
                fields: ['decision_response'],
                starterPatterns: [],
                customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-NEVER' }],
              },
            },
          },
          storedMessages,
          providerMessages,
        }),
      ).toThrow('Submitted content could not be completely inspected before processing.');
    },
  );

  it('ignores provider-part snapshot overflow for unrelated model-parameter policies', () => {
    const payload = Object.fromEntries(
      Array.from({ length: 4_200 }, (_, index) => [`safe_${index}`, `value_${index}`]),
    );

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          modelParameters: {
            pii: {
              fields: ['request_fields'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-NEVER' }],
            },
          },
        },
        providerMessages: [{ role: 'human', content: [{ type: 'vendor_content', payload }] }],
      }),
    ).not.toThrow();
  });

  it('ignores provider-part snapshot overflow for a fully captured envelope name', () => {
    const payload = Object.fromEntries(
      Array.from({ length: 4_200 }, (_, index) => [`safe_${index}`, `value_${index}`]),
    );

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-NEVER' }],
            },
          },
        },
        providerMessages: [
          { role: 'human', name: 'safe-name', content: [{ type: 'vendor_content', payload }] },
        ],
      }),
    ).not.toThrow();
  });

  it('fails closed for a selected provider content field after part snapshot overflow', () => {
    const payload = Object.fromEntries(
      Array.from({ length: 4_200 }, (_, index) => [`safe_${index}`, `value_${index}`]),
    );

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-NEVER' }],
            },
          },
        },
        providerMessages: [{ role: 'human', content: [{ type: 'vendor_content', payload }] }],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('fails closed when an incomplete provider snapshot can hide an audio transcript', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          files: {
            pii: {
              fields: ['transcript'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        providerMessages: [
          {
            role: 'human',
            content: [{ type: 'vendor_content', payload: makeIncompleteAudioCarrier() }],
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('collects every provider-supported historical file locator', () => {
    expect(
      collectModelBoundHistoricalFileIds([
        {
          files: [{ file_id: 'top-file' }],
          attachments: [{ file_id: 'display-file' }],
          content: [
            { type: 'input_file', files: [{ file_id: 'part-file' }] },
            { type: 'input_image', image_file: { file_id: 'image-file' } },
            { type: 'input_file', file_id: 'direct-file' },
            { type: 'input_file', file: { file_id: 'nested-file' } },
            { type: 'input_file', files: [{ file_id: 'part-file' }] },
          ],
        },
      ]),
    ).toEqual([
      'top-file',
      'display-file',
      'part-file',
      'image-file',
      'direct-file',
      'nested-file',
    ]);
  });

  it('bounds sparse historical file carriers before walking their declared lengths', () => {
    let contentReads = 0;
    const values = new Array<undefined | { type: string; file_id: string }>(10_000_000);
    values[0] = { type: 'input_file', file_id: 'visible-file' };
    const content = new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          contentReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(collectModelBoundHistoricalFileIdState([{ content }])).toEqual({
      fileIds: ['visible-file'],
      overflowed: true,
    });
    expect(contentReads).toBeLessThanOrEqual(4_096);
  });

  it.each([Number.NaN, -1])(
    'marks an invalid historical reference length %s incomplete without iterating',
    (invalidLength) => {
      let iteratorReads = 0;
      const files = new Proxy([{ file_id: 'unread-file' }], {
        get(target, property, receiver) {
          if (property === 'length') {
            return invalidLength;
          }
          if (property === Symbol.iterator) {
            iteratorReads++;
            throw new Error('historical iterator must not run');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(collectModelBoundHistoricalFileIdState([{ files }])).toEqual({
        fileIds: [],
        overflowed: true,
      });
      expect(iteratorReads).toBe(0);
    },
  );

  it('captures a changing historical reference length once', () => {
    let lengthReads = 0;
    const files = new Proxy([{ file_id: 'retained-file' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
          return lengthReads === 1 ? 1 : Number.NaN;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(collectModelBoundHistoricalFileIdState([{ files }])).toEqual({
      fileIds: ['retained-file'],
      overflowed: false,
    });
    expect(lengthReads).toBe(1);
  });

  it('marks unread historical messages when the file budget ends exactly', () => {
    const firstMessageFiles = Array.from({ length: 4_096 }, (_, index) => ({
      file_id: `bounded-file-${index}`,
    }));

    const state = collectModelBoundHistoricalFileIdState([
      { files: firstMessageFiles },
      { files: [{ file_id: 'unread-sensitive-file' }] },
    ]);

    expect(state.overflowed).toBe(true);
    expect(state.fileIds).toHaveLength(4_096);
    expect(state.fileIds).not.toContain('unread-sensitive-file');
  });

  it('projects source-bound and canonical files in typed backend code', () => {
    const historicalFile = {
      file_id: 'historical-file',
      filename: 'history.txt',
      text: 'historical canonical text',
    };
    const processedCurrentFile = {
      file_id: 'current-file',
      filename: 'current.png',
      type: 'image/png',
    };
    const canonicalCurrentFile = {
      ...processedCurrentFile,
      text: 'current canonical OCR text',
    };

    const withoutReplay = projectModelBoundSourceFiles({
      messageFilesBySourceMessageId: {
        ' source-message ': [{ file_id: 'current-file' }, { file_id: 'current-file' }],
      },
      sourceMessages: [{ messageId: ' source-message ' }],
      steerFileIdsBySourceMessageId: new Map([
        ['source-message', new Set(['steer-file', 'current-file'])],
      ]),
      replayHistoricalFiles: false,
      historicalFiles: [historicalFile],
      processedCurrentFiles: [processedCurrentFile],
      canonicalCurrentFiles: [canonicalCurrentFile],
    });

    expect(withoutReplay.fileIdsBySourceMessageId).toEqual(
      new Map([['source-message', ['current-file', 'steer-file']]]),
    );
    expect(withoutReplay.resolvedFiles).toEqual([canonicalCurrentFile]);

    expect(
      projectModelBoundSourceFiles({
        replayHistoricalFiles: true,
        historicalFiles: [historicalFile],
      }).resolvedFiles,
    ).toEqual([historicalFile]);
  });

  it('bounds source-file projection carriers without dispatching custom iterators', () => {
    let sourceReads = 0;
    let fileReads = 0;
    let resolvedReads = 0;
    let steerMapIteratorReads = 0;
    let steerSetIteratorReads = 0;
    let historicalMapIteratorReads = 0;
    const sourceValues = new Array<{ messageId: string } | undefined>(10_000_000);
    sourceValues[0] = { messageId: 'visible-source' };
    const sourceMessages = new Proxy(sourceValues, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          sourceReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const fileValues = new Array<{ file_id: string } | undefined>(10_000_000);
    fileValues[0] = { file_id: 'visible-file' };
    const sourceFiles = new Proxy(fileValues, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          fileReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const resolvedValues = new Array<{ file_id: string; text: string } | undefined>(10_000_000);
    resolvedValues[0] = { file_id: 'visible-file', text: 'Safe canonical file' };
    const resolvedFiles = new Proxy(resolvedValues, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          resolvedReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const steerFileIds = new Set(['steer-file']);
    Object.defineProperty(steerFileIds, Symbol.iterator, {
      configurable: true,
      value() {
        steerSetIteratorReads++;
        throw new Error('custom steer set iterator must not run');
      },
    });
    const steerFiles = new Map([['visible-source', steerFileIds]]);
    Object.defineProperty(steerFiles, Symbol.iterator, {
      configurable: true,
      value() {
        steerMapIteratorReads++;
        throw new Error('custom steer map iterator must not run');
      },
    });
    const historicalFiles = new Map([
      ['historical-file', { file_id: 'historical-file', text: 'Safe history' }],
    ]);
    Object.defineProperty(historicalFiles, Symbol.iterator, {
      configurable: true,
      value() {
        historicalMapIteratorReads++;
        throw new Error('custom historical map iterator must not run');
      },
    });

    const projection = projectModelBoundSourceFiles({
      messageFilesBySourceMessageId: { 'visible-source': sourceFiles },
      sourceMessages,
      steerFileIdsBySourceMessageId: steerFiles,
      replayHistoricalFiles: true,
      historicalFiles,
      processedCurrentFiles: resolvedFiles,
    });

    expect(projection.overflowed).toBe(true);
    expect(projection.fileIdsBySourceMessageId.get('visible-source')).toContain('visible-file');
    expect(projection.resolvedFiles).toContainEqual({
      file_id: 'historical-file',
      text: 'Safe history',
    });
    expect(sourceReads).toBeLessThanOrEqual(4_096);
    expect(fileReads).toBeLessThanOrEqual(4_096);
    expect(resolvedReads).toBeLessThanOrEqual(4_096);
    expect(steerMapIteratorReads).toBe(0);
    expect(steerSetIteratorReads).toBe(0);
    expect(historicalMapIteratorReads).toBe(0);

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [{ role: 'human', content: 'Safe content' }],
        fileIdsBySourceMessageId: projection.fileIdsBySourceMessageId,
        resolvedFiles: projection.resolvedFiles,
        sourceFileProjectionOverflowed: projection.overflowed,
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('inspects only canonical rows selected by the final provider payload', () => {
    const storedMessages = [
      {
        messageId: 'pruned-message',
        isCreatedByUser: true,
        role: 'user',
        text: 'Previously stored PRIVATE-PRUNED',
      },
      {
        messageId: 'retained-message',
        isCreatedByUser: true,
        role: 'user',
        text: 'Safe retained content',
      },
    ];

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages,
        providerMessages: [
          {
            role: 'human',
            content: 'Safe retained content',
            additional_kwargs: { sourceMessageId: 'retained-message' },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages,
        providerMessages: [
          {
            role: 'human',
            content: 'Previously stored PRIVATE-PRUNED',
            additional_kwargs: { sourceMessageId: 'pruned-message' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('inspects only the provider-bound name rather than persisted UI labels', () => {
    const nameFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['name'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-SENDER' }],
        },
      },
    };
    const storedMessages = [
      {
        messageId: 'named-user',
        role: 'user',
        isCreatedByUser: true,
        sender: 'PRIVATE-SENDER',
        name: 'PRIVATE-SENDER',
        text: 'Safe retained content',
      },
    ];

    expect(() =>
      assertModelBoundProviderContent({
        filters: nameFilters,
        storedMessages,
        providerMessages: [
          {
            role: 'human',
            content: 'Safe retained content',
            additional_kwargs: { sourceMessageId: 'named-user' },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters: nameFilters,
        storedMessages,
        providerMessages: [
          {
            role: 'human',
            name: 'PRIVATE-SENDER',
            content: 'Safe retained content',
            additional_kwargs: { sourceMessageId: 'named-user' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('mirrors provider content precedence over stale persisted text metadata', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'content-user',
            role: 'user',
            isCreatedByUser: true,
            text: 'PRIVATE-STALE',
            summary: 'PRIVATE-STALE',
            original: 'PRIVATE-STALE',
            updated: 'PRIVATE-STALE',
            content: [{ type: 'text', text: 'Safe retained content' }],
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Safe retained content',
            additional_kwargs: { sourceMessageId: 'content-user' },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            text: 'PRIVATE-STALE',
            content: [{ type: 'text', text: 'Safe exact provider content' }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('selects historical files only for retained source rows', () => {
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-FILE' }],
        },
      },
    };
    const storedMessages = [
      {
        messageId: 'pruned-message',
        isCreatedByUser: true,
        role: 'user',
        text: 'Pruned file turn',
        files: [{ file_id: 'pruned-file' }],
      },
      {
        messageId: 'retained-message',
        isCreatedByUser: true,
        role: 'user',
        text: 'Retained safe turn',
      },
    ];
    const resolvedFiles = [
      {
        file_id: 'pruned-file',
        filename: 'private.txt',
        text: 'PRIVATE-FILE',
      },
    ];

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        storedMessages,
        resolvedFiles,
        fileIdsBySourceMessageId: new Map([['pruned-message', ['pruned-file']]]),
        providerMessages: [
          {
            role: 'human',
            content: 'Retained safe turn',
            additional_kwargs: { sourceMessageId: 'retained-message' },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        storedMessages,
        resolvedFiles,
        fileIdsBySourceMessageId: new Map([['pruned-message', ['pruned-file']]]),
        providerMessages: [
          {
            role: 'human',
            content: 'Pruned file turn',
            additional_kwargs: { sourceMessageId: 'pruned-message' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('selects only user-authored file references from retained assistant rows', () => {
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-FILE' }],
        },
      },
    };
    const resolvedFiles = [
      {
        file_id: 'assistant-file',
        filename: 'private.txt',
        text: 'PRIVATE-FILE',
      },
    ];

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        resolvedFiles,
        storedMessages: [
          {
            messageId: 'model-file-message',
            isCreatedByUser: false,
            role: 'assistant',
            content: [{ type: 'input_file', file_id: 'assistant-file' }],
          },
        ],
        providerMessages: [
          {
            role: 'ai',
            content: [{ type: 'input_file', file_id: 'assistant-file' }],
            additional_kwargs: { sourceMessageId: 'model-file-message' },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        resolvedFiles,
        fileIdsBySourceMessageId: new Map([['steer-file-message', ['assistant-file']]]),
        storedMessages: [
          {
            messageId: 'steer-file-message',
            isCreatedByUser: false,
            role: 'assistant',
            content: [
              {
                type: 'steer',
                steer: 'Use this file',
                files: [{ file_id: 'assistant-file' }],
              },
            ],
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Use this file',
            additional_kwargs: { sourceMessageId: 'steer-file-message' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('ignores canonical steer locators when no file was materialized', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        storedMessages: [
          {
            messageId: 'failed-steer',
            isCreatedByUser: false,
            role: 'assistant',
            content: [
              {
                type: 'steer',
                steer: 'Text-only fallback',
                files: [{ file_id: 'not-materialized' }],
              },
            ],
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Text-only fallback',
            additional_kwargs: { sourceMessageId: 'failed-steer', source: 'steer' },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('uses only the source row that actually materialized a repeated file', () => {
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-FILE' }],
        },
      },
    };
    const storedMessages = [
      {
        messageId: 'first-source',
        isCreatedByUser: true,
        role: 'user',
        files: [{ file_id: 'shared-file' }],
      },
      {
        messageId: 'later-source',
        isCreatedByUser: true,
        role: 'user',
        files: [{ file_id: 'shared-file' }],
      },
    ];
    const resolvedFiles = [
      { file_id: 'shared-file', filename: 'private.txt', text: 'PRIVATE-FILE' },
    ];
    const fileIdsBySourceMessageId = new Map([['first-source', ['shared-file']]]);

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        storedMessages,
        resolvedFiles,
        fileIdsBySourceMessageId,
        providerMessages: [
          {
            role: 'human',
            content: 'Later text-only source',
            additional_kwargs: { sourceMessageId: 'later-source' },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        storedMessages,
        resolvedFiles,
        fileIdsBySourceMessageId,
        providerMessages: [
          {
            role: 'human',
            content: 'First source with file',
            additional_kwargs: { sourceMessageId: 'first-source' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('fails closed for an unresolved file only when its source is retained', () => {
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    const storedMessages = [
      {
        messageId: 'missing-file-message',
        isCreatedByUser: true,
        role: 'user',
        text: 'Use the missing file',
        files: [{ file_id: 'missing-file' }],
      },
      {
        messageId: 'safe-message',
        isCreatedByUser: true,
        role: 'user',
        text: 'Safe retained turn',
      },
    ];

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        storedMessages,
        fileIdsBySourceMessageId: new Map([['missing-file-message', ['missing-file']]]),
        providerMessages: [
          {
            role: 'human',
            content: 'Safe retained turn',
            additional_kwargs: { sourceMessageId: 'safe-message' },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        storedMessages,
        fileIdsBySourceMessageId: new Map([['missing-file-message', ['missing-file']]]),
        providerMessages: [
          {
            role: 'human',
            content: 'Use the missing file',
            additional_kwargs: { sourceMessageId: 'missing-file-message' },
          },
        ],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');
  });

  it('does not treat display-only historical attachments as model-bound files', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-FILE' }],
              uninspectable: 'block',
            },
          },
        },
        storedMessages: [
          {
            messageId: 'display-only',
            isCreatedByUser: true,
            role: 'user',
            text: 'Download this later',
            attachments: [{ file_id: 'display-file' }],
          },
        ],
        resolvedFiles: [
          {
            file_id: 'display-file',
            filename: 'private.txt',
            text: 'PRIVATE-FILE',
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Download this later',
            additional_kwargs: { sourceMessageId: 'display-only' },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('fails safe on an ambiguous coalesced user payload while retaining canonical provenance', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'first-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Safe first turn',
          },
          {
            messageId: 'last-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Safe last turn',
          },
        ],
        providerMessages: [
          {
            id: 'first-message',
            role: 'human',
            content: 'Safe first turn\nPRIVATE-MIDDLE\nSafe last turn',
            additional_kwargs: { sourceMessageId: 'last-message' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('inspects synthetic user content merged behind one persisted source identity', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'stored-user',
            isCreatedByUser: true,
            role: 'user',
            text: 'Safe persisted turn',
          },
        ],
        providerMessages: [
          {
            id: 'stored-user',
            role: 'human',
            content: 'Safe persisted turn\n\nPRIVATE-SYNTHETIC',
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('uses typed contribution boundaries for exact Human attribution', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            content: 'PRIVATE-BOUNDARY',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [{ attribution: 'user' }, { attribution: 'synthetic' }],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            content: 'PRIVATE-BOUNDARY',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [{ attribution: 'model' }, { attribution: 'synthetic' }],
              },
            },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-BOUNDARY' },
              ],
            },
          },
        },
        providerMessages: [
          {
            role: 'human',
            content: [{ type: 'steer', steer: 'PRIVATE-BOUNDARY' }],
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [{ attribution: 'model' }, { attribution: 'synthetic' }],
              },
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('promotes typed Human content when its selected canonical part is user-authored', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'edited-source',
            role: 'assistant',
            isCreatedByUser: false,
            content: [{ type: 'steer', steer: 'Safe retained edit' }],
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Safe retained edit plus PRIVATE-DERIVATIVE',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [
                  {
                    attribution: 'model',
                    sourceMessageId: 'edited-source',
                    sourceContentPartIndices: [0],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('routes typed artifact projections only through tool output policy', () => {
    const toolOutputFilters: FiltersConfig = {
      toolArguments: {
        pii: {
          fields: ['output'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-ARTIFACT' }],
        },
      },
    };
    const providerMessages = [
      {
        role: 'human',
        content: 'PRIVATE-ARTIFACT',
        additional_kwargs: {
          provenance: {
            version: 1 as const,
            parts: [{ attribution: 'model' as const }, { attribution: 'tool' as const }],
          },
        },
      },
    ];

    expect(() =>
      assertModelBoundProviderContent({ filters: toolOutputFilters, providerMessages }),
    ).toThrow('Submitted content contains a private value');
    expect(() => assertModelBoundProviderContent({ filters, providerMessages })).not.toThrow();
  });

  it('recognizes the legacy artifact Human after a contiguous mixed tool-result block', () => {
    const toolOutputFilters: FiltersConfig = {
      toolArguments: {
        pii: {
          fields: ['output'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-ARTIFACT' }],
        },
      },
    };
    const providerMessages = [
      {
        role: 'tool',
        content: 'Tool response is included in the next message as a Human message',
      },
      { role: 'tool', content: 'A later non-artifact tool result' },
      { role: 'human', content: 'PRIVATE-ARTIFACT' },
    ];

    expect(() =>
      assertModelBoundProviderContent({ filters: toolOutputFilters, providerMessages }),
    ).toThrow('Submitted content contains a private value');
    expect(() => assertModelBoundProviderContent({ filters, providerMessages })).not.toThrow();
  });

  it('does not reclassify synthetic skill context as a submitted message', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            content: 'Skill body with PRIVATE-SKILL',
            additional_kwargs: { isMeta: true, source: 'skill' },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            content: 'Injected PRIVATE-STEER',
            additional_kwargs: { injected: true, source: 'steer' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            content: 'User-authored PRIVATE-MOBILE',
            additional_kwargs: { source: 'mobile' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('retains explicit caller provenance on assistant-role provider messages', () => {
    const contentPartFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-EDIT' }],
        },
      },
    };
    expect(() =>
      assertModelBoundProviderContent({
        filters: contentPartFilters,
        storedMessages: [
          {
            messageId: 'edited-assistant',
            isCreatedByUser: false,
            role: 'assistant',
            content: [{ type: 'text', text: 'PRIVATE-EDIT' }],
            userSubmittedPaths: ['/content/0/text'],
          },
        ],
        providerMessages: [
          {
            role: 'ai',
            content: 'PRIVATE-EDIT',
            additional_kwargs: { sourceMessageId: 'edited-assistant' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');

    const answerFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['answer'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-HITL' }],
        },
      },
    };
    expect(() =>
      assertModelBoundProviderContent({
        filters: answerFilters,
        storedMessages: [
          {
            messageId: 'hitl-assistant',
            isCreatedByUser: false,
            role: 'assistant',
            content: [{ type: 'tool_call', tool_call: { output: 'PRIVATE-HITL' } }],
            userSubmittedMessageFieldPaths: [
              { path: '/content/0/tool_call/output', field: 'answer' },
            ],
          },
        ],
        providerMessages: [
          {
            role: 'ai',
            content: 'PRIVATE-HITL',
            additional_kwargs: { sourceMessageId: 'hitl-assistant' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('fails closed when an assistant payload assembles content across an edit boundary', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'edited-boundary',
            isCreatedByUser: false,
            role: 'assistant',
            content: [
              { type: 'text', text: 'PRIVATE-' },
              { type: 'text', text: 'SECRET' },
            ],
            userSubmittedPaths: ['/content/0/text'],
          },
        ],
        providerMessages: [
          {
            role: 'ai',
            content: 'PRIVATE-SECRET',
            additional_kwargs: { sourceMessageId: 'edited-boundary' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('does not restore a pruned steer when only a safe assistant derivative survives', () => {
    const contentFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-STEER' }],
        },
      },
    };
    const storedMessages = [
      {
        messageId: 'mixed-assistant',
        isCreatedByUser: false,
        role: 'assistant',
        content: [
          { type: 'steer', steer: 'PRIVATE-STEER' },
          { type: 'text', text: 'Safe model tail' },
        ],
        userSubmittedPaths: ['/content/0/steer'],
      },
    ];

    expect(() =>
      assertModelBoundProviderContent({
        filters: contentFilters,
        storedMessages,
        providerMessages: [
          {
            role: 'ai',
            content: 'Safe model tail',
            additional_kwargs: { sourceMessageId: 'mixed-assistant' },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters: contentFilters,
        storedMessages,
        providerMessages: [
          {
            role: 'human',
            content: 'PRIVATE-STEER',
            additional_kwargs: { sourceMessageId: 'mixed-assistant' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('uses one explicit-path snapshot when a legacy carrier shrinks', () => {
    let lengthReads = 0;
    const userSubmittedPaths = new Proxy(['/text'], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
          return lengthReads === 1 ? 1 : 0;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'shrinking-path-source',
            role: 'assistant',
            isCreatedByUser: false,
            text: 'PRIVATE-SHRINKING-PATH',
            userSubmittedPaths,
          },
        ],
        providerMessages: [
          {
            role: 'ai',
            content: 'Safe assistant derivative',
            additional_kwargs: { sourceMessageId: 'shrinking-path-source' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(lengthReads).toBe(1);
  });

  it('uses one captured content part for legacy path classification and projection', () => {
    let contentReads = 0;
    const content = new Proxy(
      [{ type: 'text', text: 'PRIVATE-CONTENT-RACE' }] as Array<{
        type: string;
        text?: string;
        steer?: string;
      }>,
      {
        get(target, property, receiver) {
          if (property === '0') {
            contentReads++;
            return contentReads === 1
              ? { type: 'text', text: 'PRIVATE-CONTENT-RACE' }
              : { type: 'steer', steer: 'Safe changed part' };
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const contentFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [
            { id: 'private', label: 'private value', regex: 'PRIVATE-CONTENT-RACE' },
          ],
        },
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: contentFilters,
        storedMessages: [
          {
            messageId: 'changing-part-source',
            role: 'assistant',
            isCreatedByUser: false,
            content,
            userSubmittedPaths: ['/content/0/text'],
          },
        ],
        providerMessages: [
          {
            role: 'ai',
            content: 'Safe assistant derivative',
            additional_kwargs: { sourceMessageId: 'changing-part-source' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(contentReads).toBeLessThanOrEqual(2);
  });

  it('uses the first selected content-part value for typed attribution and projection', () => {
    let contentReads = 0;
    const content = new Proxy([{ type: 'text', text: 'PRIVATE-SELECTED-PART' }], {
      get(target, property, receiver) {
        if (property === '0') {
          contentReads++;
          return contentReads === 1
            ? { type: 'text', text: 'PRIVATE-SELECTED-PART' }
            : { type: 'text', text: 'Safe changed part' };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const contentFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [
            { id: 'private', label: 'private value', regex: 'PRIVATE-SELECTED-PART' },
          ],
        },
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: contentFilters,
        storedMessages: [
          {
            messageId: 'selected-part-source',
            role: 'assistant',
            isCreatedByUser: false,
            content,
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Safe provider derivative',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [
                  {
                    attribution: 'user',
                    sourceMessageId: 'selected-part-source',
                    sourceContentPartIndices: [0],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(contentReads).toBe(1);
  });

  it('uses the first selected file part when resolving canonical file content', () => {
    let contentReads = 0;
    const content = new Proxy([{ type: 'input_file', file_id: 'private-selected-file' }], {
      get(target, property, receiver) {
        if (property === '0') {
          contentReads++;
          return contentReads === 1
            ? { type: 'input_file', file_id: 'private-selected-file' }
            : { type: 'text', text: 'Safe changed part' };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private file', regex: 'PRIVATE-FILE' }],
        },
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        storedMessages: [
          {
            messageId: 'selected-file-source',
            role: 'assistant',
            isCreatedByUser: false,
            content,
          },
        ],
        resolvedFiles: [
          {
            file_id: 'private-selected-file',
            filename: 'private.txt',
            text: 'PRIVATE-FILE',
          },
        ],
        fileIdsBySourceMessageId: new Map([['selected-file-source', ['private-selected-file']]]),
        providerMessages: [
          {
            role: 'human',
            content: 'Safe provider derivative',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [
                  {
                    attribution: 'user',
                    sourceMessageId: 'selected-file-source',
                    sourceContentPartIndices: [0],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private file');
    expect(contentReads).toBe(1);
  });

  it('reuses one selected file-id property snapshot for projection and file selection', () => {
    let fileIdReads = 0;
    const part = {
      type: 'input_file',
      get file_id() {
        fileIdReads++;
        return fileIdReads === 1 ? 'private-selected-file-property' : undefined;
      },
    };
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private file', regex: 'PRIVATE-FILE' }],
        },
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        storedMessages: [
          {
            messageId: 'selected-file-property-source',
            role: 'assistant',
            isCreatedByUser: false,
            content: [part],
          },
        ],
        resolvedFiles: [
          {
            file_id: 'private-selected-file-property',
            filename: 'private.txt',
            text: 'PRIVATE-FILE',
          },
        ],
        fileIdsBySourceMessageId: new Map([
          ['selected-file-property-source', ['private-selected-file-property']],
        ]),
        providerMessages: [
          {
            role: 'human',
            content: 'Safe provider derivative',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [
                  {
                    attribution: 'user',
                    sourceMessageId: 'selected-file-property-source',
                    sourceContentPartIndices: [0],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private file');
    expect(fileIdReads).toBe(1);
  });

  it('uses one top-level file snapshot for canonical file selection', () => {
    let fileCarrierReads = 0;
    const storedMessage = {
      messageId: 'top-level-file-source',
      role: 'user',
      isCreatedByUser: true,
      text: 'Safe stored text',
      get files() {
        fileCarrierReads++;
        return fileCarrierReads === 1 ? [{ file_id: 'private-top-level-file' }] : [];
      },
    };
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private file', regex: 'PRIVATE-FILE' }],
        },
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        storedMessages: [storedMessage],
        resolvedFiles: [
          {
            file_id: 'private-top-level-file',
            filename: 'private.txt',
            text: 'PRIVATE-FILE',
          },
        ],
        fileIdsBySourceMessageId: new Map([['top-level-file-source', ['private-top-level-file']]]),
        providerMessages: [
          {
            role: 'ai',
            content: 'Safe provider derivative',
            additional_kwargs: { sourceMessageId: 'top-level-file-source' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private file');
    expect(fileCarrierReads).toBe(1);
  });

  it('captures provider role and lineage metadata once', () => {
    let roleReads = 0;
    let metadataReads = 0;
    const providerMessage = {
      get role() {
        roleReads++;
        return roleReads === 1 ? 'human' : 'ai';
      },
      content: 'PRIVATE-PROVIDER-ROLE',
      get additional_kwargs() {
        metadataReads++;
        return metadataReads === 1 ? { sourceMessageId: 'provider-lineage-source' } : {};
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'provider-lineage-source',
            role: 'user',
            isCreatedByUser: true,
            text: 'PRIVATE-STORED-LINEAGE',
          },
        ],
        providerMessages: [providerMessage],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(roleReads).toBe(1);
    expect(metadataReads).toBe(1);
  });

  it('sparsely retains typed canonical parts without restoring pruned steer, HITL, or files', () => {
    const sparseFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part', 'answer'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-message',
              label: 'private value',
              regex: 'PRIVATE-(?:STEER|HITL)',
            },
          ],
        },
      },
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private-file', label: 'private file', regex: 'PRIVATE-FILE' }],
        },
      },
    };
    const storedMessages = [
      {
        messageId: 'mixed-source',
        role: 'assistant',
        isCreatedByUser: false,
        content: [
          {
            type: 'steer',
            steer: 'PRIVATE-STEER',
            tool_call: { output: 'PRIVATE-HITL' },
            files: [{ file_id: 'private-file' }],
          },
          { type: 'text', text: 'Safe retained model tail' },
        ],
        userSubmittedPaths: ['/content/0/steer', '/content/0/files/0/file_id'],
        userSubmittedMessageFieldPaths: [
          { path: '/content/0/tool_call/output', field: 'answer' as const },
        ],
      },
    ];
    const resolvedFiles = [
      { file_id: 'private-file', filename: 'private.txt', text: 'PRIVATE-FILE' },
    ];
    const baseInput = {
      filters: sparseFilters,
      storedMessages,
      resolvedFiles,
      fileIdsBySourceMessageId: new Map([['mixed-source', ['private-file']]]),
    };

    expect(() =>
      assertModelBoundProviderContent({
        ...baseInput,
        providerMessages: [
          {
            role: 'human',
            content: 'Safe retained model tail',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [
                  {
                    attribution: 'model',
                    sourceMessageId: 'mixed-source',
                    sourceContentPartIndices: [1],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        ...baseInput,
        providerMessages: [
          {
            role: 'human',
            content: 'Safe transformed provider payload',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [
                  {
                    attribution: 'model',
                    sourceMessageId: 'mixed-source',
                    sourceContentPartIndices: [0],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow(/Submitted content contains a private (?:value|file)/);
  });

  it('fails closed instead of scanning for a pruned middle file source in legacy coalescing', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-FILE' }],
            },
          },
        },
        storedMessages: [
          {
            messageId: 'first-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Safe first turn',
          },
          {
            messageId: 'middle-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Use the middle file',
            files: [{ file_id: 'middle-file' }],
          },
          {
            messageId: 'last-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Safe last turn',
          },
        ],
        resolvedFiles: [
          {
            file_id: 'middle-file',
            filename: 'middle.txt',
            text: 'PRIVATE-FILE',
          },
        ],
        fileIdsBySourceMessageId: new Map([['middle-message', ['middle-file']]]),
        providerMessages: [
          {
            id: 'first-message',
            role: 'human',
            content: 'Safe first turn\n\nSafe last turn',
            additional_kwargs: { sourceMessageId: 'last-message' },
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('fails closed for ambiguous legacy coalescing under exact HITL policy', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['answer'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-HITL' }],
            },
          },
        },
        storedMessages: [
          {
            messageId: 'first-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Safe first turn',
          },
          {
            messageId: 'last-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Safe last turn',
          },
        ],
        providerMessages: [
          {
            id: 'first-message',
            role: 'human',
            content: 'Safe first turn\n\nSafe last turn',
            additional_kwargs: { sourceMessageId: 'last-message' },
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('selects every canonical source carried by plural coalescing lineage', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-FILE' }],
            },
          },
        },
        storedMessages: [
          {
            messageId: 'first-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Safe first turn',
          },
          {
            messageId: 'middle-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Use the middle file',
            files: [{ file_id: 'middle-file' }],
          },
          {
            messageId: 'last-message',
            isCreatedByUser: true,
            role: 'user',
            text: 'Safe last turn',
          },
        ],
        resolvedFiles: [
          {
            file_id: 'middle-file',
            filename: 'middle.txt',
            text: 'PRIVATE-FILE',
          },
        ],
        fileIdsBySourceMessageId: new Map([['middle-message', ['middle-file']]]),
        providerMessages: [
          {
            id: 'first-message',
            role: 'human',
            content: 'Safe first turn\n\nUse the middle file\n\nSafe last turn',
            additional_kwargs: {
              sourceMessageId: 'last-message',
              sourceMessageIds: ['first-message', 'middle-message', 'last-message'],
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('selects typed plural sources in envelope order', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'first-source',
            role: 'user',
            isCreatedByUser: true,
            text: 'Safe first source',
          },
          {
            messageId: 'middle-source',
            role: 'user',
            isCreatedByUser: true,
            text: 'PRIVATE-MIDDLE',
          },
          {
            messageId: 'last-source',
            role: 'user',
            isCreatedByUser: true,
            text: 'Safe last source',
          },
        ],
        providerMessages: [
          {
            id: 'legacy-pruned-source',
            role: 'human',
            content: 'Safe provider projection',
            additional_kwargs: {
              sourceMessageId: 'legacy-pruned-source',
              provenance: {
                version: 1,
                parts: [
                  { attribution: 'user', sourceMessageId: 'first-source' },
                  { attribution: 'user', sourceMessageId: 'middle-source' },
                  { attribution: 'user', sourceMessageId: 'last-source' },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('bounds malformed typed and legacy lineage before canonical-only inspection', () => {
    const fileFilters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    const oversizedParts = Array.from({ length: 257 }, () => ({
      attribution: 'model' as const,
    }));
    const oversizedSourceIds = Array.from({ length: 257 }, (_, index) => `source-${index}`);

    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        providerMessages: [
          {
            role: 'human',
            content: 'Safe payload',
            additional_kwargs: {
              provenance: { version: 1, parts: oversizedParts },
            },
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(() =>
      assertModelBoundProviderContent({
        filters: fileFilters,
        providerMessages: [
          {
            role: 'human',
            content: 'Safe payload',
            additional_kwargs: { sourceMessageIds: oversizedSourceIds },
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');

    const malformedAssistantMessages = [
      {
        role: 'ai',
        content: 'PRIVATE-MALFORMED',
        additional_kwargs: {
          provenance: { version: 1 as const, parts: oversizedParts },
        },
      },
    ];
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: malformedAssistantMessages,
      }),
    ).toThrow('Submitted content contains a private value');
    expect(() =>
      assertModelBoundProviderContent({
        filters: { ...filters, ...fileFilters },
        providerMessages: malformedAssistantMessages,
      }),
    ).toThrow('Submitted content contains a private value');
    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['output'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-MALFORMED' },
              ],
            },
          },
        },
        providerMessages: malformedAssistantMessages,
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('canonicalizes accessor-backed provenance before validating and consuming it', () => {
    let attributionReads = 0;
    let sourceMessageIdReads = 0;
    let sourcePartIndicesReads = 0;
    let sourcePartIndicesLengthReads = 0;
    let versionReads = 0;
    let partsReads = 0;
    let partsLengthReads = 0;
    const sourcePartIndices = new Proxy([0], {
      get(target, property, receiver) {
        if (property === 'length') {
          sourcePartIndicesLengthReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const adversarialPart = {
      get attribution(): 'user' | 'model' {
        attributionReads++;
        return attributionReads <= 2 ? 'user' : 'model';
      },
      get sourceMessageId(): undefined {
        sourceMessageIdReads++;
        return undefined;
      },
      get sourceContentPartIndices(): readonly number[] {
        sourcePartIndicesReads++;
        return sourcePartIndices;
      },
    };
    const parts = new Proxy([adversarialPart], {
      get(target, property, receiver) {
        if (property === 'length') {
          partsLengthReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const provenance = {
      get version(): 1 {
        versionReads++;
        return 1;
      },
      get parts(): readonly (typeof adversarialPart)[] {
        partsReads++;
        return parts;
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            content: 'PRIVATE-ACCESSOR',
            additional_kwargs: {
              provenance,
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(attributionReads).toBe(1);
    expect(sourceMessageIdReads).toBe(1);
    expect(sourcePartIndicesReads).toBe(1);
    expect(sourcePartIndicesLengthReads).toBe(1);
    expect(versionReads).toBe(1);
    expect(partsReads).toBe(1);
    expect(partsLengthReads).toBe(1);
  });

  it('bounds accessor-backed legacy lineage to its captured array length', () => {
    let lengthReads = 0;
    let sourceIdReads = 0;
    const sourceMessageIds = new Proxy(['source-message'], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
        } else if (property === '0') {
          sourceIdReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            content: 'Safe provider projection',
            additional_kwargs: { sourceMessageIds },
          },
        ],
      }),
    ).not.toThrow();
    expect(lengthReads).toBe(1);
    expect(sourceIdReads).toBe(1);
  });

  it('looks up maximum typed lineage without traversing unrelated large history rows', () => {
    let unrelatedContentReads = 0;
    const unrelatedMessages = Array.from({ length: 3_840 }, (_, index) => ({
      messageId: `unrelated-${index}`,
      role: 'assistant',
      isCreatedByUser: false,
      get content() {
        unrelatedContentReads++;
        return [{ type: 'text', text: 'Unrelated model content' }];
      },
    }));
    const retainedMessages = Array.from({ length: 256 }, (_, index) => ({
      messageId: `retained-${index}`,
      role: 'assistant',
      isCreatedByUser: false,
      content: [{ type: 'text', text: `Safe retained ${index}` }],
    }));

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [...unrelatedMessages, ...retainedMessages],
        providerMessages: [
          {
            role: 'human',
            content: 'Safe exact provider content',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: retainedMessages.map((message) => ({
                  attribution: 'model' as const,
                  sourceMessageId: message.messageId,
                  sourceContentPartIndices: [0],
                })),
              },
            },
          },
        ],
      }),
    ).not.toThrow();
    expect(unrelatedContentReads).toBe(0);
  });

  it('compacts retained high-index source parts without iterating sparse holes', () => {
    let selectedContentReads = 0;
    const storedMessages = Array.from({ length: 256 }, (_, index) => {
      const values = new Array<{ type: string; steer: string } | undefined>(4_096);
      values[4_095] = { type: 'steer', steer: `Safe retained steer ${index}` };
      const content = new Proxy(values, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            selectedContentReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return {
        messageId: `high-index-${index}`,
        role: 'assistant',
        isCreatedByUser: false,
        content,
      };
    });

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages,
        providerMessages: [
          {
            role: 'human',
            content: 'Safe exact provider content',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: storedMessages.map((message) => ({
                  attribution: 'model' as const,
                  sourceMessageId: message.messageId,
                  sourceContentPartIndices: [4_095],
                })),
              },
            },
          },
        ],
      }),
    ).not.toThrow();
    expect(selectedContentReads).toBeLessThanOrEqual(1_536);
  });

  it('keeps selected semantic steer parts canonically user-authored', () => {
    const contentFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-STEER-CACHE' }],
        },
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: contentFilters,
        storedMessages: [
          {
            messageId: 'semantic-steer-source',
            role: 'assistant',
            isCreatedByUser: false,
            content: [{ type: 'steer', steer: 'PRIVATE-STEER-CACHE' }],
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Safe provider derivative',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [
                  {
                    attribution: 'model',
                    sourceMessageId: 'semantic-steer-source',
                    sourceContentPartIndices: [0],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('fails closed when a stored content length grows after provenance parsing', () => {
    let lengthReads = 0;
    let numericReads = 0;
    const values = new Array<{ type: string; text: string } | undefined>(10_000_000);
    values[0] = { type: 'text', text: 'PRIVATE-CHANGING-CONTENT' };
    const content = new Proxy(values, {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
          return lengthReads === 1 ? 1 : 10_000_000;
        }
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          numericReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private',
                  label: 'private value',
                  regex: 'PRIVATE-CHANGING-CONTENT',
                },
              ],
            },
          },
        },
        storedMessages: [
          {
            messageId: 'changing-content-source',
            role: 'user',
            isCreatedByUser: true,
            content,
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Safe provider content',
            additional_kwargs: { sourceMessageId: 'changing-content-source' },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(lengthReads).toBeLessThanOrEqual(3);
    expect(numericReads).toBeLessThanOrEqual(4_097);
  });

  it('bounds sparse provenance metadata while projecting selected canonical parts', () => {
    let pathReads = 0;
    const pathValues = new Array<string>(10_000_000);
    pathValues[0] = '/content/0/text';
    const userSubmittedPaths = new Proxy(pathValues, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          pathReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'sparse-provenance-source',
            role: 'assistant',
            isCreatedByUser: false,
            content: [{ type: 'text', text: 'Safe selected content' }],
            userSubmittedPaths,
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Safe exact provider content',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [
                  {
                    attribution: 'user',
                    sourceMessageId: 'sparse-provenance-source',
                    sourceContentPartIndices: [0],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(pathReads).toBeLessThanOrEqual(512);
  });

  it('allows one complete maximum-size canonical projection', () => {
    const content = Array.from({ length: 4_096 }, (_, index) => ({
      type: 'text',
      text: `Safe canonical part ${index}`,
    }));

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'maximum-source',
            role: 'assistant',
            isCreatedByUser: false,
            content,
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Safe exact provider content',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [{ attribution: 'user', sourceMessageId: 'maximum-source' }],
              },
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('deduplicates repeated canonical and file-selection work', () => {
    let contentReads = 0;
    const values = Array.from({ length: 1_024 }, (_, index) => ({
      type: 'text',
      text: `Safe source part ${index}`,
      files: [{ file_id: 'repeated-file' }],
    }));
    const content = new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          contentReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const parts = Array.from({ length: 256 }, (_, index) => ({
      attribution: index % 2 === 0 ? ('user' as const) : ('model' as const),
      sourceMessageId: 'repeated-source',
    }));

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages: [
          {
            messageId: 'repeated-source',
            role: 'assistant',
            isCreatedByUser: false,
            content,
          },
        ],
        resolvedFiles: [
          { file_id: 'repeated-file', filename: 'safe.txt', text: 'Safe file content' },
        ],
        fileIdsBySourceMessageId: new Map([['repeated-source', ['repeated-file']]]),
        providerMessages: [
          {
            role: 'human',
            content: 'Safe exact provider content',
            additional_kwargs: { provenance: { version: 1, parts } },
          },
        ],
      }),
    ).not.toThrow();
    expect(contentReads).toBeLessThanOrEqual(5_120);
  });

  it('defers aggregate projection overflow so a specific exact finding wins', () => {
    let contentReads = 0;
    const storedMessages = Array.from({ length: 5 }, (_, messageIndex) => {
      const values = Array.from({ length: 1_024 }, (_, partIndex) => ({
        type: 'text',
        text: `Safe ${messageIndex}-${partIndex}`,
      }));
      const content = new Proxy(values, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            contentReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return {
        messageId: `bounded-source-${messageIndex}`,
        role: 'assistant',
        isCreatedByUser: false,
        content,
      };
    });
    const provenanceParts = storedMessages.map((message) => ({
      attribution: 'user' as const,
      sourceMessageId: message.messageId,
    }));
    const baseInput = {
      filters,
      storedMessages,
      providerMessages: [
        {
          role: 'human',
          content: 'Safe exact provider content',
          additional_kwargs: { provenance: { version: 1 as const, parts: provenanceParts } },
        },
      ],
    };

    expect(() => assertModelBoundProviderContent(baseInput)).toThrow(
      'Submitted content could not be completely inspected before processing.',
    );
    expect(contentReads).toBeLessThanOrEqual(15_000);

    expect(() =>
      assertModelBoundProviderContent({
        ...baseInput,
        providerMessages: [
          {
            ...baseInput.providerMessages[0],
            content: 'PRIVATE-BUDGET',
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('preserves a full batch of 4,096 simple provider messages', () => {
    const providerMessages = Array.from({ length: 4_096 }, (_, index) => ({
      role: 'human',
      content: `Safe provider message ${index}`,
    }));

    expect(() => assertModelBoundProviderContent({ filters, providerMessages })).not.toThrow();
  });

  it('allows 4,096 provider content parts and fails closed at 4,097', () => {
    const contentFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-PREFIX' }],
        },
      },
    };
    const createMessage = (content: Array<{ type: string; text: string }>) => ({
      role: 'human',
      content,
      additional_kwargs: {
        provenance: { version: 1 as const, parts: [{ attribution: 'user' as const }] },
      },
    });
    const boundaryContent = Array.from({ length: 4_096 }, (_, index) => ({
      type: 'text',
      text: `Safe provider part ${index}`,
    }));

    expect(() =>
      assertModelBoundProviderContent({
        filters: contentFilters,
        providerMessages: [createMessage(boundaryContent)],
      }),
    ).not.toThrow();

    expect(() =>
      assertModelBoundProviderContent({
        filters: contentFilters,
        providerMessages: [
          createMessage([...boundaryContent, { type: 'text', text: 'Safe unread part' }]),
        ],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');

    const sensitivePrefix = [...boundaryContent, { type: 'text', text: 'Safe unread part' }];
    sensitivePrefix[4_095] = { type: 'text', text: 'PRIVATE-PREFIX' };
    expect(() =>
      assertModelBoundProviderContent({
        filters: contentFilters,
        providerMessages: [createMessage(sensitivePrefix)],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('snapshots provider part getters once before attribution and extraction', () => {
    let textReads = 0;
    const part = {
      type: 'text',
      get text() {
        textReads++;
        return textReads === 1 ? 'PRIVATE-FIRST-PART' : 'safe later value';
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-FIRST-PART' },
              ],
            },
          },
        },
        providerMessages: [{ role: 'human', content: [part] }],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(textReads).toBe(1);
  });

  it('snapshots nested content child getters once before manual and generic extraction', () => {
    let textReads = 0;
    const nestedPart = {
      get text() {
        textReads++;
        return textReads === 1 ? 'PRIVATE-FIRST-NESTED' : 'safe later value';
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-FIRST-NESTED' },
              ],
            },
          },
        },
        providerMessages: [{ role: 'human', content: [{ type: 'custom', content: [nestedPart] }] }],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(textReads).toBe(1);
  });

  it('reuses nested content snapshots for extraction and opaque-file checks', () => {
    let fileIdReads = 0;
    const nestedPart = {
      get file_id() {
        fileIdReads++;
        return fileIdReads === 1 ? 'opaque-private-file' : undefined;
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
        providerMessages: [{ role: 'human', content: [{ type: 'custom', content: [nestedPart] }] }],
      }),
    ).toThrow('Submitted file content could not be inspected before processing.');
    expect(fileIdReads).toBe(1);
  });

  it('snapshots nested tool-call wrappers once before tool-argument extraction', () => {
    let functionReads = 0;
    const toolCall = {
      get function() {
        functionReads++;
        return functionReads === 1
          ? { name: 'submit', arguments: 'PRIVATE-FIRST-TOOL' }
          : { name: 'submit', arguments: 'safe later value' };
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-FIRST-TOOL' },
              ],
            },
          },
        },
        providerMessages: [
          { role: 'human', content: [{ type: 'tool_call', tool_call: toolCall }] },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(functionReads).toBe(1);
  });

  it.each(['image_url', 'video_url'] as const)('snapshots %s wrapper getters once', (field) => {
    let urlReads = 0;
    const wrapper = {
      get url() {
        urlReads++;
        return urlReads === 1 ? 'https://example.test/PRIVATE-FIRST-URI' : 'https://safe.test';
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['attachment_reference'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-FIRST-URI' },
              ],
            },
          },
        },
        providerMessages: [{ role: 'human', content: [{ type: 'custom', [field]: wrapper }] }],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(urlReads).toBe(1);
  });

  it('retains bounded generic provider fields for fallback inspection', () => {
    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-GENERIC-FIELD' },
              ],
            },
          },
        },
        providerMessages: [
          {
            role: 'human',
            content: [{ type: 'custom', vendor: { secret: 'PRIVATE-GENERIC-FIELD' } }],
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('retains an own __proto__ provider field in the bounded snapshot', () => {
    const part = JSON.parse('{"type":"custom","__proto__":{"secret":"PRIVATE-PROTO-FIELD"}}');

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-PROTO-FIELD' },
              ],
            },
          },
        },
        providerMessages: [{ role: 'human', content: [part] }],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('retains an own __proto__ field on a nested content child', () => {
    const nestedPart = JSON.parse('{"__proto__":{"secret":"PRIVATE-NESTED-PROTO"}}');

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-NESTED-PROTO' },
              ],
            },
          },
        },
        providerMessages: [{ role: 'human', content: [{ type: 'custom', content: [nestedPart] }] }],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('rejects proxy provider parts without dispatching unbounded ownKeys', () => {
    let ownKeyReads = 0;
    let textReads = 0;
    const part = new Proxy(
      { type: 'text', text: 'PRIVATE-PROXY-PART' },
      {
        ownKeys(target) {
          ownKeyReads++;
          return Reflect.ownKeys(target);
        },
        get(target, property, receiver) {
          if (property === 'text') {
            textReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-PROXY-PART' },
              ],
            },
          },
        },
        providerMessages: [{ role: 'human', content: [part] }],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(ownKeyReads).toBe(0);
    expect(textReads).toBe(1);
  });

  it('rejects proxy stored parts without raw rest enumeration', () => {
    let ownKeyReads = 0;
    let textReads = 0;
    const part = new Proxy(
      { type: 'text', text: 'PRIVATE-PROXY-STORED' },
      {
        ownKeys(target) {
          ownKeyReads++;
          return Reflect.ownKeys(target);
        },
        get(target, property, receiver) {
          if (property === 'text') {
            textReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() =>
      assertModelBoundProviderContent({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [
                { id: 'private', label: 'private value', regex: 'PRIVATE-PROXY-STORED' },
              ],
            },
          },
        },
        storedMessages: [
          {
            messageId: 'stored-proxy-source',
            role: 'assistant',
            isCreatedByUser: false,
            content: [part],
          },
        ],
        providerMessages: [
          {
            role: 'human',
            content: 'Safe provider content',
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [
                  {
                    attribution: 'user',
                    sourceMessageId: 'stored-proxy-source',
                    sourceContentPartIndices: [0],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(ownKeyReads).toBe(0);
    expect(textReads).toBe(1);
  });

  it('bounds sparse provider-part projection before steer normalization', () => {
    let numericReads = 0;
    let iteratorReads = 0;
    const values = new Array<{ type: string; text: string } | undefined>(10_000_000);
    values[0] = { type: 'steer', text: 'PRIVATE-SPARSE-PROVIDER' };
    const content = new Proxy(values, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorReads++;
          throw new Error('provider content iterator must not run');
        }
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          numericReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const toolFilters: FiltersConfig = {
      toolArguments: {
        pii: {
          fields: ['output'],
          starterPatterns: [],
          customPatterns: [
            { id: 'private', label: 'private value', regex: 'PRIVATE-SPARSE-PROVIDER' },
          ],
        },
      },
    };

    expect(() =>
      assertModelBoundProviderContent({
        filters: toolFilters,
        providerMessages: [
          {
            role: 'human',
            content,
            additional_kwargs: {
              provenance: {
                version: 1,
                parts: [{ attribution: 'tool' }],
              },
            },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(numericReads).toBeLessThanOrEqual(4_096);
    expect(iteratorReads).toBe(0);
  });

  it.each([Number.NaN, -1])(
    'fails closed for typed-provenance length %s without dispatching iterators',
    (invalidLength) => {
      let iteratorReads = 0;
      const parts = new Proxy([{ attribution: 'model' as const }], {
        get(target, property, receiver) {
          if (property === 'length') {
            return invalidLength;
          }
          if (property === Symbol.iterator) {
            iteratorReads++;
            throw new Error('typed provenance iterator must not run');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(() =>
        assertModelBoundProviderContent({
          filters,
          providerMessages: [
            {
              role: 'human',
              content: 'PRIVATE-TYPED-LENGTH',
              additional_kwargs: { provenance: { version: 1, parts } },
            },
          ],
        }),
      ).toThrow('Submitted content contains a private value');
      expect(iteratorReads).toBe(0);
    },
  );

  it('captures a changing typed-provenance length once', () => {
    let lengthReads = 0;
    const parts = new Proxy([{ attribution: 'user' as const }], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
          return lengthReads === 1 ? 1 : Number.NaN;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            content: 'PRIVATE-TYPED-CHANGING',
            additional_kwargs: { provenance: { version: 1, parts } },
          },
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(lengthReads).toBe(1);
  });

  it('preserves one maximum valid typed-provenance envelope', () => {
    const parts = Array.from({ length: 256 }, (_, partIndex) => ({
      attribution: 'model' as const,
      sourceContentPartIndices: Array.from({ length: 16 }, (_, index) => partIndex * 16 + index),
    }));

    expect(() =>
      assertModelBoundProviderContent({
        filters,
        providerMessages: [
          {
            role: 'human',
            content: 'Safe maximum provenance envelope',
            additional_kwargs: { provenance: { version: 1, parts } },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('bounds typed provenance parts and index refs across the whole provider batch', () => {
    let partReads = 0;
    let indexReads = 0;
    const indexValues = Array.from({ length: 256 }, (_, index) => index);
    const sourceContentPartIndices = new Proxy(indexValues, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          indexReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const partValues = Array.from({ length: 256 }, () => ({
      attribution: 'user' as const,
      sourceContentPartIndices,
    }));
    const parts = new Proxy(partValues, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          partReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const providerMessages = Array.from({ length: 4_096 }, (_, index) => ({
      role: 'human',
      content: index === 4_095 ? 'PRIVATE-PROVENANCE-BUDGET' : `Safe provider message ${index}`,
      additional_kwargs: { provenance: { version: 1 as const, parts } },
    }));
    const safeProviderMessages = providerMessages.map((message) => ({
      ...message,
      content: message.content.replace('PRIVATE-PROVENANCE-BUDGET', 'Safe content'),
    }));

    expect(() =>
      assertModelBoundProviderContent({ filters, providerMessages: safeProviderMessages }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(partReads).toBeLessThanOrEqual(4_096);
    expect(indexReads).toBeLessThanOrEqual(4_096);

    partReads = 0;
    indexReads = 0;
    expect(() => assertModelBoundProviderContent({ filters, providerMessages })).toThrow(
      'Submitted content contains a private value',
    );
    expect(partReads).toBeLessThanOrEqual(4_096);
    expect(indexReads).toBeLessThanOrEqual(4_096);
  });

  it('bounds stored provenance-state resolution across distinct source rows', () => {
    let contentReads = 0;
    const storedMessages = Array.from({ length: 512 }, (_, messageIndex) => {
      const content = new Proxy(new Array<undefined>(4_096), {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            contentReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return {
        messageId: `state-source-${messageIndex}`,
        role: 'assistant',
        isCreatedByUser: false,
        content,
      };
    });
    const providerMessages = [0, 256].map((start, batchIndex) => ({
      role: 'human',
      content: `Safe state batch ${batchIndex}`,
      additional_kwargs: {
        provenance: {
          version: 1 as const,
          parts: storedMessages.slice(start, start + 256).map((message) => ({
            attribution: 'model' as const,
            sourceMessageId: message.messageId,
          })),
        },
      },
    }));

    expect(() =>
      assertModelBoundProviderContent({ filters, storedMessages, providerMessages }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(contentReads).toBeLessThanOrEqual(13_000);

    contentReads = 0;
    expect(() =>
      assertModelBoundProviderContent({
        filters,
        storedMessages,
        providerMessages: providerMessages.map((message, index) => ({
          ...message,
          content: index === 1 ? 'PRIVATE-STATE-BUDGET' : message.content,
        })),
      }),
    ).toThrow('Submitted content contains a private value');
    expect(contentReads).toBeLessThanOrEqual(13_000);
  });

  it('does not rescan explicit path carriers that grow after capture', () => {
    let lengthReads = 0;
    let pathReads = 0;
    const storedMessages = Array.from({ length: 512 }, (_, messageIndex) => {
      const values = new Array<string>(256).fill('/text');
      let carrierLengthReads = 0;
      const userSubmittedPaths = new Proxy(values, {
        get(target, property, receiver) {
          if (property === 'length') {
            lengthReads++;
            carrierLengthReads++;
            return carrierLengthReads === 1 ? 1 : 256;
          }
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            pathReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return {
        messageId: `growing-path-source-${messageIndex}`,
        role: 'assistant',
        isCreatedByUser: false,
        text: `Safe stored content ${messageIndex}`,
        userSubmittedPaths,
      };
    });
    const providerMessages = storedMessages.map((message, index) => ({
      role: 'ai',
      content: `Safe provider content ${index}`,
      additional_kwargs: { sourceMessageId: message.messageId },
    }));

    expect(() =>
      assertModelBoundProviderContent({ filters, storedMessages, providerMessages }),
    ).not.toThrow();
    expect(lengthReads).toBe(512);
    expect(pathReads).toBe(512);
  });

  it('bounds plural legacy lineage IDs across the whole provider batch', () => {
    let sourceIdReads = 0;
    const sourceIdValues = Array.from({ length: 256 }, (_, index) => `source-${index}`);
    const sourceMessageIds = new Proxy(sourceIdValues, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          sourceIdReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const providerMessages = Array.from({ length: 4_096 }, (_, index) => ({
      role: 'human',
      content: `Safe legacy provider message ${index}`,
      additional_kwargs: { sourceMessageIds },
    }));

    expect(() => assertModelBoundProviderContent({ filters, providerMessages })).toThrow(
      'Submitted content could not be completely inspected before processing.',
    );
    expect(sourceIdReads).toBeLessThanOrEqual(4_352);
  });

  it('bounds aggregate nested extraction across distinct selected source rows', () => {
    let nestedReads = 0;
    const nestedValues = Array.from({ length: 3_500 }, (_, index) => `safe-nested-${index}`);
    const nestedPayload = new Proxy(nestedValues, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          nestedReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const aggregateFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-NEVER' }],
        },
      },
    };
    const storedMessages = Array.from({ length: 512 }, (_, index) => ({
      messageId: `nested-source-${index}`,
      role: 'assistant',
      isCreatedByUser: false,
      content: [{ type: 'custom', payload: nestedPayload }],
    }));
    const providerMessages = [0, 256].map((offset) => ({
      role: 'human',
      content: `Safe aggregate provider content ${offset}`,
      additional_kwargs: {
        provenance: {
          version: 1 as const,
          parts: storedMessages.slice(offset, offset + 256).map((message) => ({
            attribution: 'user' as const,
            sourceMessageId: message.messageId,
            sourceContentPartIndices: [0],
          })),
        },
      },
    }));

    expect(() =>
      assertModelBoundProviderContent({
        filters: aggregateFilters,
        storedMessages,
        providerMessages,
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
    expect(nestedReads).toBeLessThanOrEqual(8_192);
  });

  it('preserves a concrete finding before aggregate nested traversal overflow', () => {
    const nestedPayload = Array.from({ length: 3_500 }, (_, index) =>
      index === 0 ? 'PRIVATE-NESTED-PREFIX' : `safe-nested-${index}`,
    );
    const aggregateFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [
            { id: 'private', label: 'private value', regex: 'PRIVATE-NESTED-PREFIX' },
          ],
        },
      },
    };
    const storedMessages = Array.from({ length: 512 }, (_, index) => ({
      messageId: `finding-nested-source-${index}`,
      role: 'assistant',
      isCreatedByUser: false,
      content: [{ type: 'custom', payload: nestedPayload }],
    }));
    const providerMessages = [0, 256].map((offset) => ({
      role: 'human',
      content: `Safe aggregate provider content ${offset}`,
      additional_kwargs: {
        provenance: {
          version: 1 as const,
          parts: storedMessages.slice(offset, offset + 256).map((message) => ({
            attribution: 'user' as const,
            sourceMessageId: message.messageId,
            sourceContentPartIndices: [0],
          })),
        },
      },
    }));

    expect(() =>
      assertModelBoundProviderContent({
        filters: aggregateFilters,
        storedMessages,
        providerMessages,
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('inspects individually bounded nested messages across callback batches', () => {
    const callbackFilters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-NEVER' }],
        },
      },
    };
    const storedMessages = [0, 1, 2].map((index) => ({
      messageId: `callback-nested-source-${index}`,
      role: 'assistant',
      isCreatedByUser: false,
      content: [
        {
          type: 'custom',
          payload: Array.from({ length: 3_000 }, (_, leaf) => `safe-${index}-${leaf}`),
        },
      ],
    }));
    const callback = createModelBoundChatModelCallback({
      filters: callbackFilters,
      storedMessages,
    });
    const createBatch = (index: number) => [
      {
        role: 'human',
        content: `Safe callback provider content ${index}`,
        additional_kwargs: {
          provenance: {
            version: 1 as const,
            parts: [
              {
                attribution: 'user' as const,
                sourceMessageId: storedMessages[index].messageId,
                sourceContentPartIndices: [0],
              },
            ],
          },
        },
      },
    ];

    expect(() =>
      callback.handleChatModelStart(undefined, [createBatch(0), createBatch(1), createBatch(2)]),
    ).not.toThrow();
  });

  it('keeps the model callback usable after caller-owned state is released', () => {
    const storedMessages = [
      {
        messageId: 'stored-message',
        isCreatedByUser: true,
        role: 'user',
        text: 'PRIVATE-SNAPSHOT',
      },
    ];
    const callback = createModelBoundChatModelCallback({ filters, storedMessages });
    storedMessages.length = 0;

    expect(() =>
      callback.handleChatModelStart(undefined, [
        [
          {
            role: 'human',
            content: 'PRIVATE-SNAPSHOT',
            additional_kwargs: { sourceMessageId: 'stored-message' },
          },
        ],
      ]),
    ).toThrow('Submitted content contains a private value');
  });

  it('bounds sparse callback snapshots before copying caller-owned state', () => {
    let storedReads = 0;
    let storedLengthReads = 0;
    let resolvedReads = 0;
    let resolvedLengthReads = 0;
    let fileIdReads = 0;
    let fileIdLengthReads = 0;
    const storedValues = new Array<undefined | { messageId: string }>(10_000_000);
    storedValues[0] = { messageId: 'visible-message' };
    const storedMessages = new Proxy(storedValues, {
      get(target, property, receiver) {
        if (property === 'length') {
          storedLengthReads++;
        } else if (typeof property === 'string' && /^\d+$/.test(property)) {
          storedReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const resolvedValues = new Array<undefined | { file_id: string; text: string }>(10_000_000);
    resolvedValues[0] = { file_id: 'visible-file', text: 'Safe file' };
    const resolvedFiles = new Proxy(resolvedValues, {
      get(target, property, receiver) {
        if (property === 'length') {
          resolvedLengthReads++;
        } else if (typeof property === 'string' && /^\d+$/.test(property)) {
          resolvedReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const fileIdValues = new Array<string>(10_000_000);
    fileIdValues[0] = 'visible-file';
    const fileIds = new Proxy(fileIdValues, {
      get(target, property, receiver) {
        if (property === 'length') {
          fileIdLengthReads++;
        } else if (typeof property === 'string' && /^\d+$/.test(property)) {
          fileIdReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    let customMapIteratorReads = 0;
    const fileIdsBySourceMessageId = new Map([['visible-message', fileIds]]);
    Object.defineProperty(fileIdsBySourceMessageId, Symbol.iterator, {
      configurable: true,
      value() {
        customMapIteratorReads++;
        throw new Error('custom map iterator must not run');
      },
    });
    const callback = createModelBoundChatModelCallback({
      filters,
      storedMessages,
      resolvedFiles,
      fileIdsBySourceMessageId,
    });

    expect(storedLengthReads).toBe(1);
    expect(resolvedLengthReads).toBe(1);
    expect(fileIdLengthReads).toBe(1);
    expect(storedReads).toBeLessThanOrEqual(4_096);
    expect(resolvedReads).toBeLessThanOrEqual(4_096);
    expect(fileIdReads).toBeLessThanOrEqual(4_096);
    expect(customMapIteratorReads).toBe(0);
    expect(() =>
      callback.handleChatModelStart(undefined, [[{ role: 'human', content: 'Safe content' }]]),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('bounds callback batches without dispatching custom array iterators', () => {
    let outerIteratorReads = 0;
    let innerIteratorReads = 0;
    let outerLengthReads = 0;
    const providerMessages = [{ role: 'human', content: 'Safe content' }];
    Object.defineProperty(providerMessages, Symbol.iterator, {
      configurable: true,
      value() {
        innerIteratorReads++;
        throw new Error('custom provider iterator must not run');
      },
    });
    const messageBatchValues = [providerMessages];
    Object.defineProperty(messageBatchValues, Symbol.iterator, {
      configurable: true,
      value() {
        outerIteratorReads++;
        throw new Error('custom batch iterator must not run');
      },
    });
    const messageBatches = new Proxy(messageBatchValues, {
      get(target, property, receiver) {
        if (property === 'length') {
          outerLengthReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const callback = createModelBoundChatModelCallback({ filters });

    expect(() => callback.handleChatModelStart(undefined, messageBatches)).not.toThrow();
    expect(outerIteratorReads).toBe(0);
    expect(innerIteratorReads).toBe(0);
    expect(outerLengthReads).toBe(1);
  });

  it.each([
    ['outer', Number.NaN],
    ['outer', -1],
    ['inner', Number.NaN],
    ['inner', -1],
  ] as const)(
    'makes an invalid %s callback-array length %s fatal without iterating',
    (carrier, invalidLength) => {
      let iteratorReads = 0;
      const providerMessages = new Proxy([{ role: 'human', content: 'PRIVATE-INVALID-LENGTH' }], {
        get(target, property, receiver) {
          if (carrier === 'inner' && property === 'length') {
            return invalidLength;
          }
          if (property === Symbol.iterator) {
            iteratorReads++;
            throw new Error('inner iterator must not run');
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const batches = new Proxy([providerMessages], {
        get(target, property, receiver) {
          if (carrier === 'outer' && property === 'length') {
            return invalidLength;
          }
          if (property === Symbol.iterator) {
            iteratorReads++;
            throw new Error('outer iterator must not run');
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const callback = createModelBoundChatModelCallback({ filters });

      expect(() => callback.handleChatModelStart(undefined, batches)).toThrow(
        'Submitted content could not be completely inspected before processing.',
      );
      expect(iteratorReads).toBe(0);
    },
  );

  it('captures a changing provider-batch length once before copying numerically', () => {
    let lengthReads = 0;
    const providerMessages = new Proxy([{ role: 'human', content: 'PRIVATE-CHANGING-LENGTH' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
          return lengthReads === 1 ? 1 : 10_000_000;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const callback = createModelBoundChatModelCallback({ filters });

    expect(() => callback.handleChatModelStart(undefined, [providerMessages])).toThrow(
      'Submitted content contains a private value',
    );
    expect(lengthReads).toBe(1);
  });

  it('enforces one provider-message traversal cap across callback batches', () => {
    let lateMessageReads = 0;
    const firstBatch = Array.from({ length: 4_096 }, (_, index) => ({
      role: 'human',
      content: `Safe callback message ${index}`,
    }));
    const lateBatch = new Proxy([{ role: 'human', content: 'Safe unread message' }], {
      get(target, property, receiver) {
        if (property === '0') {
          lateMessageReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const callback = createModelBoundChatModelCallback({ filters });

    expect(() => callback.handleChatModelStart(undefined, [firstBatch, lateBatch])).toThrow(
      'Submitted content could not be completely inspected before processing.',
    );
    expect(lateMessageReads).toBe(0);
  });

  it('shares the provenance parse budget across callback batches', () => {
    let partReads = 0;
    const partValues = Array.from({ length: 256 }, () => ({
      attribution: 'model' as const,
    }));
    const parts = new Proxy(partValues, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          partReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const messageBatches = Array.from({ length: 18 }, (_, index) => [
      {
        role: 'human',
        content: `Safe provenance batch ${index}`,
        additional_kwargs: { provenance: { version: 1 as const, parts } },
      },
    ]);
    const callback = createModelBoundChatModelCallback({ filters });

    expect(() => callback.handleChatModelStart(undefined, messageBatches)).toThrow(
      'Submitted content could not be completely inspected before processing.',
    );
    expect(partReads).toBeLessThanOrEqual(4_352);
  });

  it.each([
    [
      'batch element',
      () => {
        const batches: Array<readonly []> = [];
        Object.defineProperty(batches, '0', {
          configurable: true,
          get() {
            throw new Error('hostile batch accessor');
          },
        });
        batches.length = 1;
        return batches;
      },
    ],
    [
      'provider field',
      () => {
        const providerMessage = { content: 'Safe content' } as { role?: string; content: string };
        Object.defineProperty(providerMessage, 'role', {
          configurable: true,
          get() {
            throw new Error('hostile provider accessor');
          },
        });
        return [[providerMessage]];
      },
    ],
  ])('makes a throwing %s accessor a fatal policy rejection', (_name, createBatches) => {
    const onContentRejected = jest.fn();
    const callback = createModelBoundChatModelCallback({ filters }, { onContentRejected });
    let thrown: unknown;

    try {
      callback.handleChatModelStart(
        undefined,
        createBatches() as Parameters<typeof callback.handleChatModelStart>[1],
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StreamLimitExceededError);
    expect(isContentFilterError(thrown)).toBe(true);
    expect(onContentRejected).toHaveBeenCalledTimes(1);
    expect(thrown).toMatchObject({
      code: 'content_filter_uninspectable',
      cause: expect.objectContaining({ code: 'content_filter_uninspectable' }),
    });
  });

  it('marks callback policy failures fatal across SDK recovery paths', () => {
    const onContentRejected = jest.fn();
    const callback = createModelBoundChatModelCallback({ filters }, { onContentRejected });
    let thrown: unknown;

    try {
      callback.handleChatModelStart(undefined, [[{ role: 'human', content: 'PRIVATE-CALLBACK' }]]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StreamLimitExceededError);
    expect(isContentFilterError(thrown)).toBe(true);
    expect(onContentRejected).toHaveBeenCalledTimes(1);
    expect(thrown).toMatchObject({
      code: 'content_filter_block',
      statusCode: 400,
      message: 'Submitted content contains a private value. Remove it and try again.',
      cause: expect.objectContaining({ code: 'content_filter_block' }),
    });
  });

  const startRootModelAttempt = (
    callback: ReturnType<typeof createInitialModelBoundAdmissionCallback>,
    agentId: string,
    prefix: string,
  ) => {
    const agentNodeRunId = `${prefix}-agent-node`;
    const modelChainRunId = `${prefix}-model-chain`;
    const modelRunId = `${prefix}-llm`;
    const metadata = { agentId, langgraph_node: `agent=${agentId}` };

    callback.handleChainStart(
      undefined,
      {},
      agentNodeRunId,
      `${prefix}-graph`,
      undefined,
      { langgraph_node: `agent=${agentId}` },
      undefined,
      `agent=${agentId}`,
    );
    callback.handleChainStart(
      undefined,
      {},
      modelChainRunId,
      agentNodeRunId,
      undefined,
      metadata,
      undefined,
      'AgentModelCall',
    );
    callback.handleChatModelStart(
      undefined,
      [[{ role: 'human', content: `Safe ${agentId} input` }]],
      modelRunId,
      modelChainRunId,
      undefined,
      undefined,
      metadata,
    );

    return { agentNodeRunId, modelChainRunId, modelRunId };
  };

  it('admits persistence only after the safe starting-agent node completes', () => {
    const onAllowed = jest.fn();
    const callback = createInitialModelBoundAdmissionCallback({
      agentIds: ['agent-root'],
      isActive: () => true,
      onAllowed,
    });

    const runs = startRootModelAttempt(callback, 'agent-root', 'root');
    callback.handleLLMEnd({}, runs.modelRunId);
    expect(onAllowed).not.toHaveBeenCalled();

    /** AgentModelCall ends before post-stream validation and fallback selection. */
    callback.handleChainEnd({}, runs.modelChainRunId);
    expect(onAllowed).not.toHaveBeenCalled();

    callback.handleChainEnd({ messages: [{}] }, runs.agentNodeRunId);
    expect(onAllowed).toHaveBeenCalledTimes(1);
  });

  it('waits for every parallel starting agent and cannot revive after a policy rejection', () => {
    let active = true;
    const onAllowed = jest.fn();
    const callback = createInitialModelBoundAdmissionCallback({
      agentIds: ['agent-a', 'agent-b'],
      isActive: () => active,
      onAllowed,
    });

    const runsA = startRootModelAttempt(callback, 'agent-a', 'a');
    callback.handleLLMEnd({}, runsA.modelRunId);
    callback.handleChainEnd({}, runsA.modelChainRunId);
    callback.handleChainEnd({ messages: [{}] }, runsA.agentNodeRunId);
    expect(onAllowed).not.toHaveBeenCalled();

    /** The intrinsic content callback cancels the persistence controller
     * synchronously when the sibling root is rejected. */
    active = false;

    const runsB = startRootModelAttempt(callback, 'agent-b', 'b-late');
    callback.handleLLMEnd({}, runsB.modelRunId);
    callback.handleChainEnd({}, runsB.modelChainRunId);
    callback.handleChainEnd({ messages: [{}] }, runsB.agentNodeRunId);
    expect(onAllowed).not.toHaveBeenCalled();
  });

  it('does not let summarization or a downstream node satisfy root admission', () => {
    const onAllowed = jest.fn();
    const callback = createInitialModelBoundAdmissionCallback({
      agentIds: ['agent-root'],
      isActive: () => true,
      onAllowed,
    });

    callback.handleChainStart(
      undefined,
      {},
      'summary-node',
      'graph',
      undefined,
      { langgraph_node: 'summarize=agent-root', summarization: true },
      undefined,
      'summarize=agent-root',
    );
    callback.handleChatModelStart(
      undefined,
      [[{ role: 'human', content: 'Safe summary' }]],
      'summary-llm',
      'summary-node',
      undefined,
      undefined,
      {
        agentId: 'agent-root',
        langgraph_node: 'summarize=agent-root',
        summarization: true,
      },
    );
    callback.handleLLMEnd({}, 'summary-llm');
    callback.handleChainEnd({ messages: [{}] }, 'summary-node');
    callback.handleChainStart(
      undefined,
      {},
      'downstream-node',
      'graph',
      undefined,
      { langgraph_node: 'agent=agent-child' },
      undefined,
      'agent=agent-child',
    );
    callback.handleChatModelStart(
      undefined,
      [[{ role: 'human', content: 'Safe downstream input' }]],
      'downstream-llm',
      'downstream-node',
      undefined,
      undefined,
      { agentId: 'agent-child', langgraph_node: 'agent=agent-child' },
    );
    callback.handleLLMEnd({}, 'downstream-llm');
    callback.handleChainEnd({ messages: [{}] }, 'downstream-node');

    expect(onAllowed).not.toHaveBeenCalled();
  });

  it('keeps the root pending across a summarization detour after a completed model attempt', () => {
    const onAllowed = jest.fn();
    const callback = createInitialModelBoundAdmissionCallback({
      agentIds: ['agent-root'],
      isActive: () => true,
      onAllowed,
    });

    const beforeSummary = startRootModelAttempt(callback, 'agent-root', 'before-summary');
    callback.handleLLMEnd({}, beforeSummary.modelRunId);
    callback.handleChainEnd({}, beforeSummary.modelChainRunId);
    callback.handleChainEnd(
      { messages: [{}], summarizationRequest: { reason: 'overflow' } },
      beforeSummary.agentNodeRunId,
    );
    expect(onAllowed).not.toHaveBeenCalled();

    const afterSummary = startRootModelAttempt(callback, 'agent-root', 'after-summary');
    callback.handleLLMEnd({}, afterSummary.modelRunId);
    callback.handleChainEnd({}, afterSummary.modelChainRunId);
    callback.handleChainEnd({ messages: [{}] }, afterSummary.agentNodeRunId);
    expect(onAllowed).toHaveBeenCalledTimes(1);
  });

  it('does not admit after a safe primary attempt when its fallback is policy-blocked', () => {
    let active = true;
    const onAllowed = jest.fn();
    const callback = createInitialModelBoundAdmissionCallback({
      agentIds: ['agent-root'],
      isActive: () => active,
      onAllowed,
    });

    const runs = startRootModelAttempt(callback, 'agent-root', 'fallback');
    callback.handleLLMEnd({}, runs.modelRunId);
    callback.handleChainError(
      new Error('Primary response failed validation'),
      runs.modelChainRunId,
    );
    expect(onAllowed).not.toHaveBeenCalled();

    /** The intrinsic model callback cancels persistence when the fallback's
     * exact payload is rejected before it can complete the agent node. */
    active = false;
    callback.handleChainError(new Error('Blocked fallback'), runs.agentNodeRunId);
    expect(onAllowed).not.toHaveBeenCalled();
  });
});
