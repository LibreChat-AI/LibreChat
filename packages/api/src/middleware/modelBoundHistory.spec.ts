import { ContentTypes } from 'librechat-data-provider';
import { formatAgentMessages } from '@librechat/agents';
import type { FiltersConfig } from 'librechat-data-provider';
import type { TPayload } from '@librechat/agents';
import type { ModelBoundProviderMessage } from './modelBoundContent';
import {
  assertModelBoundContent,
  collectModelBoundHistoricalFileIdState,
  createModelBoundChatModelCallback,
  projectModelBoundSourceFiles,
} from './modelBoundContent';
import { resolveCanonicalFileReferenceUnits } from '../protection/files';
import { assertConversationImportContentAllowed } from '../imports';

const filters: FiltersConfig = {
  messages: {
    pii: {
      fields: ['text', 'content_part', 'assembled_context'],
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-HISTORY' }],
    },
  },
  files: {
    pii: {
      fields: ['extracted_text'],
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-FILE' }],
      uninspectable: 'block',
    },
  },
};

/** Dustin's PR #15841 bundle: 58 user turns, 80 text parts each, optionally interleaved. */
function createHistory(interleaved: boolean) {
  return Array.from({ length: 58 }, (_, turn) => {
    const user = {
      messageId: `history-user-${turn}`,
      role: 'user' as const,
      isCreatedByUser: true,
      isUserSubmitted: true,
      text: `Historical user step ${turn}`,
      files: [] as { file_id: string }[],
      content: Array.from({ length: 80 }, (_, part) => ({
        type: ContentTypes.TEXT,
        text: `safe preview material ${turn}-${part}`,
      })),
    };
    return interleaved
      ? [
          user,
          {
            messageId: `history-assistant-${turn}`,
            role: 'assistant' as const,
            isCreatedByUser: false,
            // The import boundary marks assistant rows as user-submitted too.
            isUserSubmitted: true,
            text: `Acknowledged historical step ${turn}`,
            files: [] as { file_id: string }[],
            content: [{ type: ContentTypes.TEXT, text: `Acknowledged historical step ${turn}` }],
          },
        ]
      : [user];
  }).flat();
}

it.each([
  { interleaved: false, agents: false },
  { interleaved: true, agents: false },
  { interleaved: false, agents: true },
  { interleaved: true, agents: true },
])('continues the imported attachment history: %j', async ({ interleaved, agents }) => {
  const history = createHistory(interleaved);
  const canonicalFile = { file_id: 'owned', text: 'CUSTOMER_HISTORY_ATTACHMENT_OK' };
  const getFiles = jest.fn(async () => [canonicalFile]);
  const context = { user: { id: 'owner', tenantId: 'tenant' }, getFiles };
  await assertConversationImportContentAllowed(
    filters,
    { conversations: [], messages: history },
    context,
  );

  const attachedTurn = {
    ...history[0],
    messageId: 'attachment-turn',
    content: [{ type: ContentTypes.TEXT, text: 'Store this attachment. Reply only FILE_STORED.' }],
    files: [{ file_id: 'owned' }],
  };
  history.push(attachedTurn);

  for (const reload of [false, true]) {
    const storedMessages = reload
      ? (JSON.parse(JSON.stringify(history)) as typeof history)
      : history;
    getFiles.mockClear();
    const hydration = await resolveCanonicalFileReferenceUnits({
      ...context,
      filters,
      input: storedMessages,
    });
    expect(getFiles).toHaveBeenCalledTimes(1);
    expect(getFiles).toHaveBeenCalledWith(
      { file_id: { $in: ['owned'] }, user: 'owner', tenantId: 'tenant' },
      {},
      {},
    );
    assertModelBoundContent({ filters, storedMessages, resolvedFiles: hydration.hydratedFiles });
    const historicalFileState = collectModelBoundHistoricalFileIdState(storedMessages);
    expect(historicalFileState).toEqual({ fileIds: ['owned'], overflowed: false });
    const projection = projectModelBoundSourceFiles({
      sourceMessages: storedMessages,
      messageFilesBySourceMessageId: Object.fromEntries(
        storedMessages.map((m) => [m.messageId, m.files]),
      ),
      replayHistoricalFiles: true,
      historicalFiles: hydration.hydratedFiles,
      initiallyOverflowed: historicalFileState.overflowed,
    });
    expect(projection.overflowed).toBe(false);
    const payload: TPayload = storedMessages;
    const providerMessages = agents
      ? (formatAgentMessages(payload).messages as ModelBoundProviderMessage[])
      : storedMessages.map((message) => ({
          id: message.messageId,
          role: message.role,
          content: message.content,
        }));
    const callbackInput = {
      filters,
      storedMessages,
      resolvedFiles: projection.resolvedFiles,
      fileIdsBySourceMessageId: projection.fileIdsBySourceMessageId,
      sourceFileProjectionOverflowed: projection.overflowed,
    };
    const callback = createModelBoundChatModelCallback(callbackInput);
    expect(() => callback.handleChatModelStart(undefined, [providerMessages])).not.toThrow();
    expect(() => callback.handleChatModelStart(undefined, [providerMessages])).not.toThrow();

    expect(() =>
      assertModelBoundContent({
        ...callbackInput,
        resolvedFiles: [{ ...canonicalFile, text: 'PRIVATE-FILE' }],
      }),
    ).toThrow('Submitted content contains a private value');

    const lateContent = { role: 'user', content: [{ type: 'text', text: 'PRIVATE-HISTORY' }] };
    expect(() =>
      callback.handleChatModelStart(undefined, [[...providerMessages, lateContent]]),
    ).toThrow('Submitted content contains a private value');
  }
});

it('keeps a cached source snapshot failure fatal on later callback invocations', () => {
  const storedMessages = [
    {
      messageId: 'source',
      role: 'user',
      isCreatedByUser: true,
      content: [
        { type: 'text', text: 'safe' },
        {
          type: 'text',
          get text(): string {
            throw new Error('uninspectable source part');
          },
        },
      ],
    },
  ];
  const callback = createModelBoundChatModelCallback({ filters, storedMessages });
  const batch = (part: number) => [
    [
      {
        role: 'user',
        content: 'safe provider text',
        additional_kwargs: {
          provenance: {
            version: 1 as const,
            parts: [
              {
                attribution: 'user' as const,
                sourceMessageId: 'source',
                sourceContentPartIndices: [part],
              },
            ],
          },
        },
      },
    ],
  ];
  expect(() => callback.handleChatModelStart(undefined, batch(0))).not.toThrow();
  expect(() => callback.handleChatModelStart(undefined, batch(1))).toThrow(
    'Submitted content could not be completely inspected before processing.',
  );
  expect(() => callback.handleChatModelStart(undefined, batch(1))).toThrow(
    'Submitted content could not be completely inspected before processing.',
  );
});

it('keeps persisted user-submitted path bookkeeping per message', () => {
  const storedMessages = createHistory(true).map((message) => ({
    ...message,
    userSubmittedPaths: message.content.map((_part, index) => `/content/${index}/text`),
  }));
  const callback = createModelBoundChatModelCallback({ filters, storedMessages });
  const providerMessages = storedMessages.map((message) => ({
    id: message.messageId,
    role: message.role,
    content: message.content,
  }));
  expect(() => callback.handleChatModelStart(undefined, [providerMessages])).not.toThrow();
});
