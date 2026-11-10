import { Tools, Constants, MAX_FILE_TEXT_PREVIEW_LENGTH } from 'librechat-data-provider';
import type { TFile, TMessage, TAttachment } from 'librechat-data-provider';
import {
  sanitizeMessageForTransmit,
  sanitizeFileForTransmit,
  buildMessageFiles,
  getThreadData,
  isPreliminaryMessageId,
  isUnpersistedPreliminaryParent,
  getPreliminaryResponseMessageId,
  isValidMessageId,
  MAX_MESSAGE_ID_LENGTH,
} from './message';

/** Cast to string for type compatibility with ThreadMessage */
const NO_PARENT = Constants.NO_PARENT as string;

describe('sanitizeFileForTransmit', () => {
  it('should remove text field from file', () => {
    const file = {
      file_id: 'test-123',
      filename: 'test.txt',
      text: 'This is a very long text content that should be stripped',
      bytes: 1000,
    };

    const result = sanitizeFileForTransmit(file);

    expect(result.file_id).toBe('test-123');
    expect(result.filename).toBe('test.txt');
    expect(result.bytes).toBe(1000);
    expect(result).not.toHaveProperty('text');
  });

  it('should remove _id and __v fields', () => {
    const file = {
      file_id: 'test-123',
      _id: 'mongo-id',
      __v: 0,
      filename: 'test.txt',
    };

    const result = sanitizeFileForTransmit(file);

    expect(result.file_id).toBe('test-123');
    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('__v');
  });

  it.each([undefined, null, 'text'] as const)(
    'derives a plain-text preview with textFormat %p',
    (textFormat) => {
      const file = {
        file_id: 'test-123',
        type: 'text/plain',
        text: 'Authorized attachment text',
        textFormat,
        textPreview: 'Stale preview',
      };

      const result = sanitizeFileForTransmit(file);

      expect(result.textPreview).toBe(file.text);
      expect(result).not.toHaveProperty('text');
    },
  );

  it.each([0, 239, 240, 241, 5000])('bounds a %i-character text preview', (length) => {
    const text = 'x'.repeat(length);

    const result = sanitizeFileForTransmit({ type: 'text/plain', text });

    expect(MAX_FILE_TEXT_PREVIEW_LENGTH).toBe(240);
    expect(result.textPreview).toBe(text.slice(0, MAX_FILE_TEXT_PREVIEW_LENGTH));
    expect(result.textPreview?.length).toBeLessThanOrEqual(MAX_FILE_TEXT_PREVIEW_LENGTH);
    expect(result).not.toHaveProperty('text');
  });

  it.each([undefined, 'text/plain', 'text/html', 'application/pdf', 'image/png'])(
    'omits previews for HTML-formatted files with MIME type %p',
    (type) => {
      const result = sanitizeFileForTransmit({
        type,
        textFormat: 'html',
        text: '<p>Full HTML document</p>',
        textPreview: '<p>Stored HTML</p>',
      });

      expect(result).not.toHaveProperty('textPreview');
      expect(result).not.toHaveProperty('text');
    },
  );

  it.each([undefined, 'text/html', 'application/pdf', 'image/png'])(
    'omits extracted and retained previews for MIME type %p',
    (type) => {
      const result = sanitizeFileForTransmit({
        type,
        textFormat: 'text',
        text: 'Extracted text',
        textPreview: 'Stored preview',
      });
      const persisted = sanitizeFileForTransmit({ type, textPreview: 'Stored preview' });

      expect(result).not.toHaveProperty('textPreview');
      expect(result).not.toHaveProperty('text');
      expect(persisted).not.toHaveProperty('textPreview');
    },
  );

  it.each([0, 100, 240, 5000])(
    'preserves and bounds a %i-character persisted preview without full text',
    (length) => {
      const textPreview = 'p'.repeat(length);

      const result = sanitizeFileForTransmit({ type: 'text/plain', textPreview });

      expect(result.textPreview).toBe(textPreview.slice(0, MAX_FILE_TEXT_PREVIEW_LENGTH));
      expect(result).not.toHaveProperty('text');
    },
  );

  it.each([null, 42, true, [], {}])('drops a malformed persisted preview %p', (textPreview) => {
    const file = { type: 'text/plain', textPreview } as unknown as Partial<TFile>;

    expect(sanitizeFileForTransmit(file)).not.toHaveProperty('textPreview');
  });

  it('does not substitute an old preview for empty full text', () => {
    const result = sanitizeFileForTransmit({
      type: 'text/plain',
      text: '',
      textPreview: 'Stale preview',
    });

    expect(result.textPreview).toBe('');
    expect(result).not.toHaveProperty('text');
  });

  it('should not modify original file object', () => {
    const file = Object.freeze({
      file_id: 'test-123',
      type: 'text/plain',
      text: 'original text',
      textPreview: 'old preview',
    });

    const result = sanitizeFileForTransmit(file);

    expect(result).not.toBe(file);
    expect(result.textPreview).toBe('original text');
    expect(file.text).toBe('original text');
    expect(file.textPreview).toBe('old preview');
  });
});

describe('sanitizeMessageForTransmit', () => {
  it('should remove fileContext from message', () => {
    const message = {
      messageId: 'msg-123',
      text: 'Hello world',
      fileContext: 'This is a very long context that should be stripped',
    };

    const result = sanitizeMessageForTransmit(message);

    expect(result.messageId).toBe('msg-123');
    expect(result.text).toBe('Hello world');
    expect(result).not.toHaveProperty('fileContext');
  });

  it('removes encoded provider inputs before transmission without consuming the originals', () => {
    const payload = Object.freeze({
      toJSON: () => {
        throw new Error('Provider payload must not be serialized');
      },
    });
    const files = [{ file_id: 'f-1', filename: 'clip.mp4', type: 'video/mp4', bytes: 1000 }];
    const message = Object.freeze({
      messageId: 'msg-123',
      text: 'Summarize the attachments',
      documents: [payload],
      videos: [payload],
      audios: [payload],
      files,
      attachments: [
        {
          file_id: 'output-1',
          messageId: 'msg-123',
          toolCallId: 'call-1',
          user: 'user-1',
          bytes: 16,
          embedded: false,
          filename: 'output.txt',
          filepath: '/uploads/output.txt',
          object: 'file',
          type: Tools.execute_code,
          usage: 1,
          text: 'Generated output',
        } satisfies TAttachment,
      ],
    });

    const result = sanitizeMessageForTransmit(message);

    expect(result).not.toHaveProperty('documents');
    expect(result).not.toHaveProperty('videos');
    expect(result).not.toHaveProperty('audios');
    expect(result.files).toEqual(files);
    expect(result.attachments).toBe(message.attachments);
    expect(result.text).toBe(message.text);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(sanitizeMessageForTransmit(result)).toEqual(result);
    expect(message.documents[0]).toBe(payload);
    expect(message.videos[0]).toBe(payload);
    expect(message.audios[0]).toBe(payload);
  });

  it('should sanitize files array', () => {
    const message = {
      messageId: 'msg-123',
      files: [
        { file_id: 'file-1', text: 'long text 1', filename: 'a.txt' },
        { file_id: 'file-2', text: 'long text 2', filename: 'b.txt' },
      ],
    };

    const result = sanitizeMessageForTransmit(message);

    expect(result.files).toHaveLength(2);
    expect(result.files?.[0].file_id).toBe('file-1');
    expect(result.files?.[0].filename).toBe('a.txt');
    expect(result.files?.[0]).not.toHaveProperty('text');
    expect(result.files?.[1]).not.toHaveProperty('text');
  });

  it('retains a bounded preview after persistence and repeated sanitization', () => {
    const text = 'authorized pasted text '.repeat(100);
    const message = {
      messageId: 'msg-123',
      fileContext: text,
      image_urls: ['data:image/png;base64,prompt-input'],
      files: buildMessageFiles(
        [{ file_id: 'file-1' }],
        [{ file_id: 'file-1', filename: 'paste.txt', type: 'text/plain', text }],
      ),
    };
    const persisted: typeof message = JSON.parse(JSON.stringify(message));

    const first: Partial<TMessage> = sanitizeMessageForTransmit(persisted);
    const second: Partial<TMessage> = sanitizeMessageForTransmit(first);

    expect(second).toEqual(first);
    expect(second.files?.[0].textPreview).toBe(text.slice(0, MAX_FILE_TEXT_PREVIEW_LENGTH));
    expect(second.files?.[0]).not.toHaveProperty('text');
    expect(second).not.toHaveProperty('fileContext');
    expect(second).not.toHaveProperty('image_urls');
    expect(first.files).not.toBe(persisted.files);
    expect(second.files).not.toBe(first.files);
    expect(second.files?.[0]).not.toBe(first.files?.[0]);
    expect(persisted.fileContext).toBe(text);
  });

  it('sanitizes legacy full text and oversized previews without mutating the message', () => {
    const text = 'full text '.repeat(100);
    const textPreview = 'stored preview '.repeat(100);
    const message = {
      messageId: 'msg-123',
      files: [
        { file_id: 'file-1', type: 'text/plain', text },
        { file_id: 'file-2', type: 'text/plain', textPreview },
      ],
    };

    const first = sanitizeMessageForTransmit(message);
    const second = sanitizeMessageForTransmit(first);

    expect(second.files?.map((file) => file.textPreview)).toEqual([
      text.slice(0, MAX_FILE_TEXT_PREVIEW_LENGTH),
      textPreview.slice(0, MAX_FILE_TEXT_PREVIEW_LENGTH),
    ]);
    expect(second.files?.[0]).not.toHaveProperty('text');
    expect(second.files?.[1]).not.toHaveProperty('text');
    expect(message.files[0].text).toBe(text);
    expect(message.files[1].textPreview).toBe(textPreview);
  });

  it('should handle null/undefined message', () => {
    expect(sanitizeMessageForTransmit(null as unknown as object)).toBeNull();
    expect(sanitizeMessageForTransmit(undefined as unknown as object)).toBeUndefined();
  });

  it('should handle message without files', () => {
    const message = {
      messageId: 'msg-123',
      text: 'Hello',
    };

    const result = sanitizeMessageForTransmit(message);

    expect(result.messageId).toBe('msg-123');
    expect(result.text).toBe('Hello');
  });

  it('should create new array reference for empty files array (immutability)', () => {
    const message = {
      messageId: 'msg-123',
      files: [] as { file_id: string }[],
    };

    const result = sanitizeMessageForTransmit(message);

    expect(result.files).toEqual([]);
    // New array reference ensures full immutability even for empty arrays
    expect(result.files).not.toBe(message.files);
  });

  it('should not modify original message object', () => {
    const message = {
      messageId: 'msg-123',
      fileContext: 'original context',
      files: [{ file_id: 'file-1', text: 'original text' }],
    };

    sanitizeMessageForTransmit(message);

    expect(message.fileContext).toBe('original context');
    expect(message.files[0].text).toBe('original text');
  });
});

describe('isUnpersistedPreliminaryParent', () => {
  it('returns false without querying for non-preliminary parent ids', async () => {
    const getMessages = jest.fn();

    await expect(
      isUnpersistedPreliminaryParent({
        userId: 'user-123',
        conversationId: 'conversation-123',
        parentMessageId: 'persisted-response',
        getMessages,
      }),
    ).resolves.toBe(false);

    expect(isPreliminaryMessageId('persisted-response')).toBe(false);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('returns true when the underscore-suffixed parent is not persisted', async () => {
    const getMessages = jest.fn().mockResolvedValue([]);

    await expect(
      isUnpersistedPreliminaryParent({
        userId: 'user-123',
        conversationId: 'conversation-123',
        parentMessageId: 'pending-response_',
        getMessages,
      }),
    ).resolves.toBe(true);

    expect(getMessages).toHaveBeenCalledWith(
      { user: 'user-123', messageId: 'pending-response_', conversationId: 'conversation-123' },
      '_id',
    );
  });

  it('returns false when the underscore-suffixed parent is already persisted', async () => {
    const getMessages = jest.fn().mockResolvedValue([{ _id: 'persisted-parent' }]);

    await expect(
      isUnpersistedPreliminaryParent({
        userId: 'user-123',
        conversationId: 'conversation-123',
        parentMessageId: 'persisted-response_',
        getMessages,
      }),
    ).resolves.toBe(false);
  });
});

it('sanitizes plain database identity objects without stringifying them for preview derivation', () => {
  const file = {
    file_id: 'mongo-paste',
    type: 'text/plain',
    text: 'stored paste',
    _id: { toString: () => 'document-id' },
    user: { toString: () => 'owner-id' },
  };
  const result = sanitizeFileForTransmit(file);
  expect(result.textPreview).toBe('stored paste');
  expect(result).not.toHaveProperty('_id');
  expect(result).not.toHaveProperty('text');
});

describe('buildMessageFiles', () => {
  const baseAttachment = {
    file_id: 'file-1',
    filename: 'test.png',
    filepath: '/uploads/test.png',
    type: 'image/png',
    bytes: 512,
    object: 'file' as const,
    user: 'user-1',
    embedded: false,
    usage: 0,
    text: 'big ocr text',
    _id: 'mongo-id',
  };

  it('returns sanitized files matching request file IDs', () => {
    const result = buildMessageFiles([{ file_id: 'file-1' }], [baseAttachment]);
    expect(result).toHaveLength(1);
    expect(result?.[0].file_id).toBe('file-1');
    expect(result?.[0]).not.toHaveProperty('text');
    expect(result?.[0]).not.toHaveProperty('_id');
  });

  it('uses only authorized attachment text, never request file metadata', () => {
    const text = 'Authorized pasted text '.repeat(100);
    const authorized = { ...baseAttachment, type: 'text/plain', text };
    const unmatched = {
      ...authorized,
      file_id: 'unrequested-file',
      text: 'Secret from an unrequested attachment',
    };
    const requestFiles = [
      {
        file_id: 'file-1',
        type: 'text/plain',
        text: 'Forged request text',
        textPreview: 'Forged request preview',
        filename: 'forged.txt',
      },
      {
        file_id: 'unauthorized-file',
        type: 'text/plain',
        text: 'Unauthorized request text',
        textPreview: 'Unauthorized request preview',
      },
    ];

    const result: Partial<TFile>[] = buildMessageFiles(requestFiles, [authorized, unmatched]);

    expect(result).toHaveLength(1);
    expect(result[0].file_id).toBe('file-1');
    expect(result[0].filename).toBe(authorized.filename);
    expect(result[0].textPreview).toBe(text.slice(0, MAX_FILE_TEXT_PREVIEW_LENGTH));
    expect(result[0]).not.toHaveProperty('text');
    expect(result[0]).not.toHaveProperty('_id');
    expect(authorized.text).toBe(text);
  });

  it('does not read request previews or fall back to request text', () => {
    const requestFile = {
      file_id: 'file-1',
      get text() {
        throw new Error('Request text must not be read');
      },
      get textPreview() {
        throw new Error('Request preview must not be read');
      },
    };
    const { text: _text, ...attachment } = baseAttachment;

    const result = buildMessageFiles([requestFile], [{ ...attachment, type: 'text/plain' }]);

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('textPreview');
  });

  it('returns undefined when no attachments match request IDs', () => {
    const result = buildMessageFiles([{ file_id: 'file-nomatch' }], [baseAttachment]);
    expect(result).toEqual([]);
  });

  it('returns undefined for empty attachments array', () => {
    const result = buildMessageFiles([{ file_id: 'file-1' }], []);
    expect(result).toEqual([]);
  });

  it('returns undefined for empty request files array', () => {
    const result = buildMessageFiles([], [baseAttachment]);
    expect(result).toEqual([]);
  });

  it('filters out undefined file_id entries in request files (no set poisoning)', () => {
    const undefinedAttachment = { ...baseAttachment, file_id: undefined as unknown as string };
    const result = buildMessageFiles(
      [{ file_id: undefined }, { file_id: 'file-1' }],
      [undefinedAttachment, baseAttachment],
    );
    expect(result).toHaveLength(1);
    expect(result?.[0].file_id).toBe('file-1');
  });

  it('returns only attachments whose file_id is in the request set', () => {
    const attachment2 = { ...baseAttachment, file_id: 'file-2', filename: 'b.png' };
    const result = buildMessageFiles([{ file_id: 'file-1' }], [baseAttachment, attachment2]);
    expect(result).toHaveLength(1);
    expect(result?.[0].file_id).toBe('file-1');
  });

  it('does not mutate original attachment objects', () => {
    buildMessageFiles([{ file_id: 'file-1' }], [baseAttachment]);
    expect(baseAttachment.text).toBe('big ocr text');
    expect(baseAttachment._id).toBe('mongo-id');
  });
});

describe('getThreadData', () => {
  it('should return empty result for empty messages array', () => {
    const result = getThreadData([], 'parent-123');

    expect(result.messageIds).toEqual([]);
    expect(result.fileIds).toEqual([]);
  });

  it('should return empty result for null parentMessageId', () => {
    const messages = [
      { messageId: 'msg-1', parentMessageId: null },
      { messageId: 'msg-2', parentMessageId: 'msg-1' },
    ];

    const result = getThreadData(messages, null);

    expect(result.messageIds).toEqual([]);
    expect(result.fileIds).toEqual([]);
  });

  it('should return empty result for undefined parentMessageId', () => {
    const messages = [{ messageId: 'msg-1', parentMessageId: null }];

    const result = getThreadData(messages, undefined);

    expect(result.messageIds).toEqual([]);
    expect(result.fileIds).toEqual([]);
  });

  it('should return empty result when parentMessageId not found in messages', () => {
    const messages = [
      { messageId: 'msg-1', parentMessageId: null },
      { messageId: 'msg-2', parentMessageId: 'msg-1' },
    ];

    const result = getThreadData(messages, 'non-existent');

    expect(result.messageIds).toEqual([]);
    expect(result.fileIds).toEqual([]);
  });

  describe('thread traversal', () => {
    it('should traverse a simple linear thread', () => {
      const messages = [
        { messageId: 'msg-1', parentMessageId: NO_PARENT },
        { messageId: 'msg-2', parentMessageId: 'msg-1' },
        { messageId: 'msg-3', parentMessageId: 'msg-2' },
      ];

      const result = getThreadData(messages, 'msg-3');

      expect(result.messageIds).toEqual(['msg-3', 'msg-2', 'msg-1']);
      expect(result.fileIds).toEqual([]);
    });

    it('should stop at NO_PARENT constant', () => {
      const messages = [
        { messageId: 'msg-1', parentMessageId: NO_PARENT },
        { messageId: 'msg-2', parentMessageId: 'msg-1' },
      ];

      const result = getThreadData(messages, 'msg-2');

      expect(result.messageIds).toEqual(['msg-2', 'msg-1']);
    });

    it('should collect only messages in the thread branch', () => {
      // Branched conversation: msg-1 -> msg-2 -> msg-3 (branch A)
      //                       msg-1 -> msg-4 -> msg-5 (branch B)
      const messages = [
        { messageId: 'msg-1', parentMessageId: NO_PARENT },
        { messageId: 'msg-2', parentMessageId: 'msg-1' },
        { messageId: 'msg-3', parentMessageId: 'msg-2' },
        { messageId: 'msg-4', parentMessageId: 'msg-1' },
        { messageId: 'msg-5', parentMessageId: 'msg-4' },
      ];

      const resultBranchA = getThreadData(messages, 'msg-3');
      expect(resultBranchA.messageIds).toEqual(['msg-3', 'msg-2', 'msg-1']);

      const resultBranchB = getThreadData(messages, 'msg-5');
      expect(resultBranchB.messageIds).toEqual(['msg-5', 'msg-4', 'msg-1']);
    });

    it('should handle single message thread', () => {
      const messages = [{ messageId: 'msg-1', parentMessageId: NO_PARENT }];

      const result = getThreadData(messages, 'msg-1');

      expect(result.messageIds).toEqual(['msg-1']);
      expect(result.fileIds).toEqual([]);
    });
  });

  describe('circular reference protection', () => {
    it('should handle circular references without infinite loop', () => {
      // Malformed data: msg-2 points to msg-3 which points back to msg-2
      const messages = [
        { messageId: 'msg-1', parentMessageId: NO_PARENT },
        { messageId: 'msg-2', parentMessageId: 'msg-3' },
        { messageId: 'msg-3', parentMessageId: 'msg-2' },
      ];

      const result = getThreadData(messages, 'msg-2');

      // Should stop when encountering a visited ID
      expect(result.messageIds).toEqual(['msg-2', 'msg-3']);
      expect(result.fileIds).toEqual([]);
    });

    it('should handle self-referencing message', () => {
      const messages = [{ messageId: 'msg-1', parentMessageId: 'msg-1' }];

      const result = getThreadData(messages, 'msg-1');

      expect(result.messageIds).toEqual(['msg-1']);
    });
  });

  describe('file ID collection', () => {
    it('should collect file IDs from messages with files', () => {
      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: NO_PARENT,
          files: [{ file_id: 'file-1' }, { file_id: 'file-2' }],
        },
        {
          messageId: 'msg-2',
          parentMessageId: 'msg-1',
          files: [{ file_id: 'file-3' }],
        },
      ];

      const result = getThreadData(messages, 'msg-2');

      expect(result.messageIds).toEqual(['msg-2', 'msg-1']);
      expect(result.fileIds).toContain('file-1');
      expect(result.fileIds).toContain('file-2');
      expect(result.fileIds).toContain('file-3');
      expect(result.fileIds).toHaveLength(3);
    });

    it('should deduplicate file IDs across messages', () => {
      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: NO_PARENT,
          files: [{ file_id: 'file-shared' }, { file_id: 'file-1' }],
        },
        {
          messageId: 'msg-2',
          parentMessageId: 'msg-1',
          files: [{ file_id: 'file-shared' }, { file_id: 'file-2' }],
        },
      ];

      const result = getThreadData(messages, 'msg-2');

      expect(result.fileIds).toContain('file-shared');
      expect(result.fileIds).toContain('file-1');
      expect(result.fileIds).toContain('file-2');
      expect(result.fileIds).toHaveLength(3);
    });

    it('should skip files without file_id', () => {
      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: NO_PARENT,
          files: [{ file_id: 'file-1' }, { file_id: undefined }, { file_id: '' }],
        },
      ];

      const result = getThreadData(messages, 'msg-1');

      expect(result.fileIds).toEqual(['file-1']);
    });

    it('should handle messages with empty files array', () => {
      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: NO_PARENT,
          files: [],
        },
        {
          messageId: 'msg-2',
          parentMessageId: 'msg-1',
          files: [{ file_id: 'file-1' }],
        },
      ];

      const result = getThreadData(messages, 'msg-2');

      expect(result.messageIds).toEqual(['msg-2', 'msg-1']);
      expect(result.fileIds).toEqual(['file-1']);
    });

    it('should handle messages without files property', () => {
      const messages = [
        { messageId: 'msg-1', parentMessageId: NO_PARENT },
        {
          messageId: 'msg-2',
          parentMessageId: 'msg-1',
          files: [{ file_id: 'file-1' }],
        },
      ];

      const result = getThreadData(messages, 'msg-2');

      expect(result.messageIds).toEqual(['msg-2', 'msg-1']);
      expect(result.fileIds).toEqual(['file-1']);
    });

    it('should only collect files from messages in the thread', () => {
      // msg-3 is not in the thread from msg-2
      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: NO_PARENT,
          files: [{ file_id: 'file-1' }],
        },
        {
          messageId: 'msg-2',
          parentMessageId: 'msg-1',
          files: [{ file_id: 'file-2' }],
        },
        {
          messageId: 'msg-3',
          parentMessageId: 'msg-1',
          files: [{ file_id: 'file-3' }],
        },
      ];

      const result = getThreadData(messages, 'msg-2');

      expect(result.fileIds).toContain('file-1');
      expect(result.fileIds).toContain('file-2');
      expect(result.fileIds).not.toContain('file-3');
    });
  });

  describe('attachment ID collection (code-execution outputs)', () => {
    /* Code-execution outputs land on `messages.attachments`, not
     * `messages.files` — `processCodeOutput` writes the artifact
     * there. Walking only `files` silently dropped every code-output
     * file_id, so the next turn's `tool_resources.execute_code.file_ids`
     * came up empty and the sandbox saw `_injected_files: []`. The
     * user-visible symptom: "the previous file isn't persisted
     * between executions" on a single linear thread (no branching
     * needed). Lock the contract that both fields are walked. */
    it('collects file_ids from message.attachments (code-execution outputs)', () => {
      const messages = [
        { messageId: 'msg-user', parentMessageId: NO_PARENT },
        {
          messageId: 'msg-assistant',
          parentMessageId: 'msg-user',
          attachments: [{ file_id: 'attach-1' }, { file_id: 'attach-2' }],
        },
      ];

      const result = getThreadData(messages, 'msg-assistant');

      expect(result.fileIds).toContain('attach-1');
      expect(result.fileIds).toContain('attach-2');
      expect(result.fileIds).toHaveLength(2);
    });

    it('walks both files (user uploads) and attachments (code outputs) on the same message', () => {
      /* In practice they land on different roles by convention, but
       * the walk shouldn't depend on that — it should be honest about
       * collecting from both arrays regardless of where they appear. */
      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: NO_PARENT,
          files: [{ file_id: 'user-uploaded' }],
          attachments: [{ file_id: 'code-generated' }],
        },
      ];

      const result = getThreadData(messages, 'msg-1');

      expect(result.fileIds).toContain('user-uploaded');
      expect(result.fileIds).toContain('code-generated');
      expect(result.fileIds).toHaveLength(2);
    });

    it('regression: collects code-output across user→assistant→user→assistant chain', () => {
      /* Mirrors the exact failure mode from the field report — two
       * sequential turns producing the same xlsx, both attachments
       * on assistant messages. With only `files` walked, turn 2's
       * priming ran with `file_ids=0` and the sandbox FileNotFound'd. */
      const messages = [
        { messageId: 'user-1', parentMessageId: NO_PARENT },
        {
          messageId: 'asst-1',
          parentMessageId: 'user-1',
          attachments: [{ file_id: 'sample-xlsx-v1' }],
        },
        { messageId: 'user-2', parentMessageId: 'asst-1' },
        {
          messageId: 'asst-2',
          parentMessageId: 'user-2',
          attachments: [{ file_id: 'sample-xlsx-v2' }],
        },
      ];

      /* From parentMessageId = 'asst-2', walking back through the
       * full chain. Both attachment file_ids must surface so
       * primeFiles can resolve them via getCodeGeneratedFiles. */
      const result = getThreadData(messages, 'asst-2');

      expect(result.fileIds).toContain('sample-xlsx-v1');
      expect(result.fileIds).toContain('sample-xlsx-v2');
      expect(result.fileIds).toHaveLength(2);
    });

    it('dedupes file_ids that appear in both files and attachments arrays', () => {
      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: NO_PARENT,
          files: [{ file_id: 'shared-id' }],
          attachments: [{ file_id: 'shared-id' }, { file_id: 'attach-only' }],
        },
      ];

      const result = getThreadData(messages, 'msg-1');

      expect(result.fileIds).toContain('shared-id');
      expect(result.fileIds).toContain('attach-only');
      expect(result.fileIds).toHaveLength(2);
    });

    it('skips attachments without file_id (mirrors files behavior)', () => {
      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: NO_PARENT,
          attachments: [{ file_id: 'attach-1' }, { file_id: undefined }, { file_id: '' }],
        },
      ];

      const result = getThreadData(messages, 'msg-1');

      expect(result.fileIds).toEqual(['attach-1']);
    });

    it('handles messages with empty attachments array', () => {
      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: NO_PARENT,
          attachments: [],
        },
      ];

      const result = getThreadData(messages, 'msg-1');

      expect(result.fileIds).toEqual([]);
    });
  });

  describe('performance - O(1) lookups', () => {
    it('should handle large message arrays efficiently', () => {
      // Create a linear thread of 1000 messages
      const messages = [];
      for (let i = 0; i < 1000; i++) {
        messages.push({
          messageId: `msg-${i}`,
          parentMessageId: i === 0 ? NO_PARENT : `msg-${i - 1}`,
          files: [{ file_id: `file-${i}` }],
        });
      }

      const startTime = performance.now();
      const result = getThreadData(messages, 'msg-999');
      const endTime = performance.now();

      expect(result.messageIds).toHaveLength(1000);
      expect(result.fileIds).toHaveLength(1000);
      // Should complete in reasonable time (< 100ms for 1000 messages)
      expect(endTime - startTime).toBeLessThan(100);
    });
  });
});

describe('bounded turn message identities', () => {
  it.each([
    '550e8400-e29b-41d4-a716-446655440000',
    'nanoid_-.123',
    'steer-recovery:turn:user',
    'message__',
    'a'.repeat(MAX_MESSAGE_ID_LENGTH),
  ])('accepts supported identifier %s', (messageId) => {
    expect(isValidMessageId(messageId)).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    42,
    {},
    [],
    'a b',
    'a/b',
    'a\n',
    'a\0',
    'é',
    'a'.repeat(MAX_MESSAGE_ID_LENGTH + 1),
    '_'.repeat(80_000) + 'X',
  ])('rejects malformed or oversized identities', (messageId) => {
    expect(isValidMessageId(messageId)).toBe(false);
    expect(getPreliminaryResponseMessageId({ messageId })).toBeNull();
  });

  it.each([
    ['message', 'message_'],
    ['message_', 'message_'],
    ['message___', 'message_'],
    ['_', '_'],
    ['____', '_'],
    ['_'.repeat(MAX_MESSAGE_ID_LENGTH - 1) + 'X', '_'.repeat(MAX_MESSAGE_ID_LENGTH - 1) + 'X_'],
  ])('normalizes trailing underscores without backtracking', (messageId, expected) => {
    expect(getPreliminaryResponseMessageId({ messageId })).toBe(expected);
  });

  it('accepts a maximum-length user identity and its preliminary response on regeneration', () => {
    const messageId = 'a'.repeat(MAX_MESSAGE_ID_LENGTH);
    const responseMessageId = getPreliminaryResponseMessageId({ messageId });
    expect(responseMessageId).toBe(`${messageId}_`);
    expect(getPreliminaryResponseMessageId({ responseMessageId })).toBe(responseMessageId);
    expect(
      getPreliminaryResponseMessageId({ responseMessageId: `${responseMessageId}_` }),
    ).toBeNull();
  });

  it('normalizes a maximum-length preliminary response used as a compaction anchor', () => {
    const messageId = `${'a'.repeat(MAX_MESSAGE_ID_LENGTH)}_`;
    expect(getPreliminaryResponseMessageId({ messageId, compact: true })).toBe(messageId);
    expect(getPreliminaryResponseMessageId({ messageId })).toBeNull();
    expect(
      getPreliminaryResponseMessageId({ messageId: `${messageId}_`, compact: true }),
    ).toBeNull();
    expect(
      getPreliminaryResponseMessageId({ messageId: '_'.repeat(80_000) + 'X', compact: true }),
    ).toBeNull();
  });

  it('uses the live response when a compaction suffix would exceed the bound', () => {
    const messageId = 'a'.repeat(MAX_MESSAGE_ID_LENGTH + 1);
    expect(
      getPreliminaryResponseMessageId({
        compact: true,
        messageId,
        liveResponseMessageId: 'allocated-response',
      }),
    ).toBe('allocated-response');
    for (const liveResponseMessageId of [undefined, '', messageId, 'b'.repeat(258), 'invalid/id']) {
      expect(
        getPreliminaryResponseMessageId({ compact: true, messageId, liveResponseMessageId }),
      ).toBeNull();
    }
  });

  it('keeps generated identities within the response contract across compaction retries', () => {
    for (let length = 1; length <= MAX_MESSAGE_ID_LENGTH + 1; length++) {
      for (const suffix of ['', '_', '___']) {
        let messageId = `${'a'.repeat(length - 1)}X${suffix}`.slice(0, MAX_MESSAGE_ID_LENGTH + 1);
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = getPreliminaryResponseMessageId({
            compact: true,
            messageId,
            liveResponseMessageId: `allocated-${attempt}`,
          });
          expect(response).not.toBeNull();
          expect(isValidMessageId(response, MAX_MESSAGE_ID_LENGTH + 1)).toBe(true);
          if (response == null) {
            throw new Error('Missing compaction response identity');
          }
          messageId = response;
        }
      }
    }
  });

  it('uses a valid explicit response identity', () => {
    expect(
      getPreliminaryResponseMessageId({ messageId: 'user', responseMessageId: 'response' }),
    ).toBe('response');
  });

  it.each(['', {}, '_'.repeat(80_000) + 'X'])(
    'rejects an invalid explicit response identity',
    (responseMessageId) => {
      expect(getPreliminaryResponseMessageId({ messageId: 'user', responseMessageId })).toBeNull();
    },
  );
});
