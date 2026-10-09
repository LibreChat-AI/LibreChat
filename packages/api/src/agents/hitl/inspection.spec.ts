import { Constants } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { getResumeContentInspection } from './inspection';

const strictExtractedTextConfig = {
  filters: {
    files: {
      pii: {
        fields: ['extracted_text'],
        starterPatterns: [],
        uninspectable: 'block',
      },
    },
  },
} as unknown as AppConfig;

function buildInput(trustLiveFileContent?: boolean) {
  return {
    appConfig: strictExtractedTextConfig,
    conversationId: 'conversation-1',
    targetMessageId: 'message-1',
    user: { id: 'user-1' },
    supplementalMessages: [
      {
        messageId: 'message-1',
        conversationId: 'conversation-1',
        parentMessageId: String(Constants.NO_PARENT),
        text: '',
        isCreatedByUser: true,
        files: [{ file_id: 'owned-file' }],
      },
    ],
    submittedMessages: [],
    liveFiles: [
      {
        file_id: 'owned-file',
        filename: 'forged.txt',
        type: 'text/plain',
        source: 'text',
        text: 'forged safe extraction',
      },
    ],
    ...(trustLiveFileContent != null && { trustLiveFileContent }),
    isTemporary: false,
    getMessages: jest.fn().mockResolvedValue([]),
    getFiles: jest.fn().mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'opaque.pdf',
        type: 'application/pdf',
        source: 'local',
      },
    ]),
  };
}

describe('resume file inspection trust boundary', () => {
  it('resumes a long persisted branch with one batched owner-file lookup', async () => {
    const input = buildInput();
    const history = Array.from({ length: 58 }, (_, index) => ({
      messageId: `history-${index}`,
      parentMessageId: index === 0 ? String(Constants.NO_PARENT) : `history-${index - 1}`,
      conversationId: 'conversation-1',
      isCreatedByUser: true,
      content: Array.from({ length: 80 }, () => ({ type: 'text', text: 'safe history' })),
      files: index === 57 ? [{ file_id: 'owned-file' }] : [],
    }));
    input.getMessages.mockResolvedValue(history);
    input.getFiles.mockResolvedValue([{ file_id: 'owned-file', text: 'safe extraction' }]);
    const result = await getResumeContentInspection({
      ...input,
      targetMessageId: 'history-57',
      supplementalMessages: [],
      fileReferenceInputs: history,
    });
    expect(result.storedMessages).toHaveLength(58);
    expect(result.originalStoredMessages).toEqual(history);
    expect(result.hydratedFiles).toEqual([{ file_id: 'owned-file', text: 'safe extraction' }]);
    expect(input.getFiles).toHaveBeenCalledTimes(1);
  });

  it('does not accept request/job file metadata as extraction coverage', async () => {
    await expect(getResumeContentInspection(buildInput())).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
  });

  it('accepts explicitly trusted server-hydrated runtime extraction', async () => {
    await expect(getResumeContentInspection(buildInput(true))).resolves.toMatchObject({
      hydratedFiles: [
        expect.objectContaining({
          file_id: 'owned-file',
          filename: 'opaque.pdf',
          text: 'forged safe extraction',
        }),
      ],
    });
  });

  it('hydrates file references carried only by additional checkpoint structures', async () => {
    const input = {
      ...buildInput(),
      fileReferenceInputs: [
        {
          tool_calls: [{ arguments: { file_id: 'checkpoint-only-file' } }],
        },
      ],
    };
    input.getFiles.mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'safe.txt',
        type: 'text/plain',
        source: 'local',
        content: 'safe extracted content',
        extractedText: 'safe extracted content',
      },
    ]);

    await expect(getResumeContentInspection(input)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
    expect(input.getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: expect.arrayContaining(['owned-file', 'checkpoint-only-file']) },
        user: 'user-1',
      },
      {},
      {},
    );
  });

  it('does not reload persisted history for an inert message sibling policy', async () => {
    const getMessages = jest.fn().mockRejectedValue(new Error('history should not be loaded'));
    const result = await getResumeContentInspection({
      appConfig: {
        filters: {
          skills: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
          messages: { pii: { starterPatterns: [] } },
          toolArguments: { pii: { starterPatterns: [] } },
        },
      } as unknown as AppConfig,
      conversationId: 'conversation-1',
      targetMessageId: 'missing-message',
      user: { id: 'user-1' },
      supplementalMessages: [],
      submittedMessages: [],
      liveFiles: [],
      isTemporary: false,
      getMessages,
      getFiles: jest.fn().mockResolvedValue([]),
    });

    expect(result.storedMessages).toEqual([]);
    expect(getMessages).not.toHaveBeenCalled();
  });
});
