import { Constants } from 'librechat-data-provider';
import {
  sanitizeMessageForTransmit,
  sanitizeFileForTransmit,
  buildMessageFiles,
  getThreadData,
  isPreliminaryMessageId,
  isUnpersistedPreliminaryParent,
  attachProviderItems,
  stripProviderItems,
  omitProviderItemsFromEvent,
  omitReasoningReplayFromDelta,
} from './message';
import { thinkReplayHash } from '@librechat/data-schemas';
import { sendEvent } from './events';

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

  it('should not modify original file object', () => {
    const file = {
      file_id: 'test-123',
      text: 'original text',
    };

    sanitizeFileForTransmit(file);

    expect(file.text).toBe('original text');
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

describe('provider output items', () => {
  const providerItems = { origin: 'digest', items: [{ id: 'rs_1', encrypted_content: 'opaque' }] };
  const content = () => [
    { type: 'text', text: 'Looking it up.' },
    { type: 'tool_call', tool_call: { id: 'call_1', name: 'lookup', args: '{}', providerItems } },
  ];
  const toolCall = { id: 'call_1', name: 'lookup', args: '{}' };

  it('leaves them out of a final event and a sync event', () => {
    const final = omitProviderItemsFromEvent({
      final: true,
      responseMessage: { messageId: 'm', content: content() },
    });
    expect(final.responseMessage.content[1]).toEqual({ type: 'tool_call', tool_call: toolCall });
    expect(final.responseMessage.messageId).toBe('m');
    const sync = omitProviderItemsFromEvent({
      sync: true,
      resumeState: { runSteps: [], aggregatedContent: content() },
    });
    expect(sync.resumeState.aggregatedContent[1]).toEqual({
      type: 'tool_call',
      tool_call: toolCall,
    });
    expect(sync.resumeState.runSteps).toEqual([]);
  });

  it('touches nothing else, however deep a key named like them sits', () => {
    const event = { data: { output: { providerItems: 'a tool result field' } } };
    expect(omitProviderItemsFromEvent(event)).toBe(event);
    const plain = { final: true, responseMessage: { content: [{ type: 'text', text: 'x' }] } };
    expect(omitProviderItemsFromEvent(plain)).toBe(plain);
    expect(omitProviderItemsFromEvent(undefined)).toBeUndefined();
    expect(omitProviderItemsFromEvent('text')).toBe('text');
  });

  it('leaves them out of a sent event', () => {
    const write = jest.fn();
    sendEvent(
      { write } as never,
      { final: true, responseMessage: { content: content() } } as never,
    );
    expect(write.mock.calls[0][0]).toContain('call_1');
    expect(write.mock.calls[0][0]).not.toContain('opaque');
  });

  it('strips them from content without touching the input', () => {
    const input = content();
    const stripped = stripProviderItems(input);
    expect(stripped[1]).toEqual({ type: 'tool_call', tool_call: toolCall });
    expect(stripped[0]).toBe(input[0]);
    expect(input[1].tool_call?.providerItems).toBe(providerItems);
  });

  it('returns content without them, or no content, unchanged', () => {
    const clean = [{ type: 'tool_call', tool_call: { id: 'call_1' } }, null];
    expect(stripProviderItems(clean)).toBe(clean);
    expect(stripProviderItems(undefined)).toBeUndefined();
    expect(stripProviderItems('text')).toBe('text');
  });

  it('puts the stored items back on their tool calls for formatting, without changing the row', () => {
    const row = {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_call', tool_call: toolCall },
        { type: 'tool_call', tool_call: { id: 'call_2', name: 'other' } },
      ],
      providerItems: { call_1: providerItems, call_9: { origin: 'x', items: [] } },
    };
    const attached = attachProviderItems(row);
    expect(attached.content[1]).toEqual({
      type: 'tool_call',
      tool_call: { ...toolCall, providerItems },
    });
    expect(attached.content[2]).toBe(row.content[2]);
    expect(row.content[1].tool_call).toEqual(toolCall);
  });

  it('returns a row without stored items, or without list content, as it is', () => {
    const plain = { content: [{ type: 'text', text: 'x' }] };
    expect(attachProviderItems(plain)).toBe(plain);
    const text = { content: 'x', providerItems: { call_1: providerItems } };
    expect(attachProviderItems(text)).toBe(text);
  });
});

describe('signed reasoning of think parts', () => {
  const replay = {
    anthropic: { model: 'claude-test', blocks: [{ type: 'thinking', signature: 'SIG_1' }] },
  };
  const live = () => [
    { type: 'think', think: 'plan', provider_replay: replay },
    { type: 'text', text: 'answer' },
  ];

  it('strips it from content without touching the input', () => {
    const input = live();
    const stripped = stripProviderItems(input);
    expect(stripped[0]).toEqual({ type: 'think', think: 'plan' });
    expect(stripped[1]).toBe(input[1]);
    expect(input[0]).toHaveProperty('provider_replay');
  });

  it('leaves it out of a final event and a sync event', () => {
    const final = omitProviderItemsFromEvent({ final: true, responseMessage: { content: live() } });
    expect(JSON.stringify(final)).not.toContain('SIG_1');
    const sync = omitProviderItemsFromEvent({ resumeState: { aggregatedContent: live() } });
    expect(JSON.stringify(sync)).not.toContain('SIG_1');
  });

  it('leaves it out of a reasoning delta for the client, and returns a plain delta as it is', () => {
    const delta = { id: 'step_1', delta: { content: live().slice(0, 1) } };
    const forwarded = omitReasoningReplayFromDelta(delta);
    expect(JSON.stringify(forwarded)).not.toContain('SIG_1');
    expect(forwarded.delta.content[0]).toEqual({ type: 'think', think: 'plan' });
    expect(delta.delta.content[0]).toHaveProperty('provider_replay');
    const plain = { id: 'step_1', delta: { content: [{ type: 'think', think: 'x' }] } };
    expect(omitReasoningReplayFromDelta(plain)).toBe(plain);
    expect(omitReasoningReplayFromDelta(delta, false)).toBe(delta);
    expect(omitReasoningReplayFromDelta(undefined)).toBeUndefined();
  });

  it('puts the stored replay back on its part while the text is the one it was stored with', () => {
    const row = {
      content: [
        { type: 'think', think: 'plan' },
        { type: 'text', text: 'answer' },
      ],
      providerItems: { 'think:0': { hash: thinkReplayHash('plan'), replay } },
    };
    const attached = attachProviderItems(row);
    expect(attached.content[0]).toEqual({ type: 'think', think: 'plan', provider_replay: replay });
    expect(row.content[0]).toEqual({ type: 'think', think: 'plan' });
  });

  it('does not put it back on a part whose text was edited, or that moved', () => {
    const items = { 'think:0': { hash: thinkReplayHash('plan'), replay } };
    const edited = attachProviderItems({
      content: [{ type: 'think', think: 'plan, edited' }],
      providerItems: items,
    });
    expect(edited.content[0]).toEqual({ type: 'think', think: 'plan, edited' });
    const moved = attachProviderItems({
      content: [
        { type: 'text', text: 'new first part' },
        { type: 'think', think: 'plan' },
      ],
      providerItems: items,
    });
    expect(JSON.stringify(moved.content)).not.toContain('SIG_1');
  });
});
