import { ContentTypes } from 'librechat-data-provider';
import type { TAttachment, TConversation, TMessage } from 'librechat-data-provider';
import {
  forkFileScope,
  withoutMessageFiles,
  withoutUnsentFiles,
  withoutExcludedFiles,
  scopeHistoricalReplay,
  withoutConversationFiles,
} from './files';
import { ATTACHMENT_ONLY_TEXT } from '~/files/context';

const upload = { file_id: 'upload-1', filename: 'screenshot.png', type: 'image/png' };
const output = { file_id: 'output-1', filename: 'chart.png', toolCallId: 'call-1' } as TAttachment;

describe('withoutMessageFiles', () => {
  it('drops uploads and the token count that covered them, keeping the text', () => {
    const message: Partial<TMessage> = {
      messageId: 'user-1',
      text: 'What is in this screenshot?',
      isCreatedByUser: true,
      files: [upload],
      tokenCount: 1600,
    };

    expect(withoutMessageFiles(message)).toEqual({
      messageId: 'user-1',
      text: 'What is in this screenshot?',
      isCreatedByUser: true,
    });
  });

  it('drops code outputs but keeps the token count of a turn that had no uploads', () => {
    const content = [{ type: 'text', text: 'Here is the chart.' }] as TMessage['content'];
    const message: Partial<TMessage> = {
      messageId: 'assistant-1',
      text: '',
      content,
      attachments: [output],
      tokenCount: 42,
    };

    expect(withoutMessageFiles(message)).toEqual({
      messageId: 'assistant-1',
      text: '',
      content,
      tokenCount: 42,
    });
  });

  it('drops attachments steered into a response, and the count that covered them', () => {
    const content = [
      { type: ContentTypes.TEXT, text: 'Working on it.' },
      { type: ContentTypes.STEER, steer: 'Use this one instead', steerId: 's1', files: [upload] },
      { type: ContentTypes.STEER, steer: 'And be brief', steerId: 's2' },
    ] as TMessage['content'];
    const message: Partial<TMessage> = { messageId: 'assistant-2', content, tokenCount: 900 };

    expect(withoutMessageFiles(message)).toEqual({
      messageId: 'assistant-2',
      content: [
        { type: ContentTypes.TEXT, text: 'Working on it.' },
        { type: ContentTypes.STEER, steer: 'Use this one instead', steerId: 's1' },
        { type: ContentTypes.STEER, steer: 'And be brief', steerId: 's2' },
      ],
    });
    expect(content?.[1]).toHaveProperty('files', [upload]);
  });

  it('drops content parts that are themselves stored files', () => {
    const content = [
      { type: ContentTypes.TEXT, text: 'Here is the image.' },
      { type: ContentTypes.IMAGE_FILE, image_file: { file_id: 'generated-1' } },
      { type: 'file', file: { file_id: 'provider-file-1' } },
      { type: 'input_file', file_id: 'direct-1' },
    ] as unknown as TMessage['content'];
    const message: Partial<TMessage> = { messageId: 'assistant-4', content, tokenCount: 30 };

    expect(withoutMessageFiles(message)).toEqual({
      messageId: 'assistant-4',
      content: [{ type: ContentTypes.TEXT, text: 'Here is the image.' }],
    });
  });

  it('keeps metadata-only attachments such as search sources', () => {
    const sources = { type: 'web_search', toolCallId: 'call-2', messageId: 'a' } as TAttachment;
    const message: Partial<TMessage> = { messageId: 'assistant-3', attachments: [output, sources] };

    expect(withoutMessageFiles(message)).toEqual({
      messageId: 'assistant-3',
      attachments: [sources],
    });
  });

  it('treats an empty upload list as no uploads', () => {
    expect(withoutMessageFiles({ messageId: 'user-2', files: [], tokenCount: 7 })).toEqual({
      messageId: 'user-2',
      tokenCount: 7,
    });
  });

  it('leaves the source message untouched', () => {
    const message: Partial<TMessage> = { messageId: 'user-3', files: [upload], tokenCount: 9 };
    withoutMessageFiles(message);
    expect(message).toEqual({ messageId: 'user-3', files: [upload], tokenCount: 9 });
  });
});

describe('withoutConversationFiles', () => {
  it('drops conversation file ids and keeps the settings', () => {
    const conversation: Partial<TConversation> & { files?: string[]; excludedFiles?: string[] } = {
      conversationId: 'convo-1',
      title: 'Screenshots',
      model: 'gpt-4o',
      files: ['upload-1'],
      file_ids: ['legacy-1'],
      excludedFiles: ['upload-1'],
    };

    expect(withoutConversationFiles(conversation)).toEqual({
      conversationId: 'convo-1',
      title: 'Screenshots',
      model: 'gpt-4o',
    });
  });
});

describe('forkFileScope', () => {
  const message: Partial<TMessage> = { messageId: 'user-1', files: [upload], tokenCount: 3 };
  const conversation = { conversationId: 'convo-1', files: ['upload-1'] };

  it('copies files unless exclusion is asked for', () => {
    const scope = forkFileScope();
    expect(scope.message(message)).toBe(message);
    expect(scope.conversation(conversation)).toBe(conversation);
  });

  it('leaves every file reference out when excluding', () => {
    const scope = forkFileScope(true);
    expect(scope.message(message)).toEqual({ messageId: 'user-1' });
    expect(scope.conversation(conversation)).toEqual({ conversationId: 'convo-1' });
  });
});

describe('withoutExcludedFiles', () => {
  const kept = { file_id: 'kept-1', filename: 'notes.pdf', type: 'application/pdf' };
  const history: Partial<TMessage>[] = [
    {
      messageId: 'user-1',
      text: 'Compare these',
      isCreatedByUser: true,
      files: [upload, kept],
      tokenCount: 1600,
    },
    { messageId: 'assistant-1', text: 'Here is a chart', attachments: [output] },
    { messageId: 'user-2', text: 'Thanks' },
  ];

  it('returns the same array, and the same messages, when nothing is left out', () => {
    expect(withoutExcludedFiles(history, undefined)).toBe(history);
    expect(withoutExcludedFiles(history, [])).toBe(history);
    expect(withoutExcludedFiles(history, ['a-file-this-chat-never-had'])).toBe(history);
  });

  it('drops only the left-out upload and copies only the message that named it', () => {
    const result = withoutExcludedFiles(history, [upload.file_id]);

    expect(result[0]).toEqual({ ...history[0], files: [kept] });
    expect(result[1]).toBe(history[1]);
    expect(result[2]).toBe(history[2]);
    expect(history[0].files).toEqual([upload, kept]);
  });

  it('keeps the stored token count, which errs toward budgeting too much', () => {
    const [message] = withoutExcludedFiles(history, [upload.file_id, kept.file_id]);

    expect(message.files).toEqual([]);
    expect(message.tokenCount).toBe(1600);
  });

  it('drops a left-out code output and keeps attachments that are not files', () => {
    const sources = { type: 'web_search', toolCallId: 'call-2' } as unknown as TAttachment;
    const messages: Partial<TMessage>[] = [
      { messageId: 'assistant-1', attachments: [output, sources] },
    ];

    const [message] = withoutExcludedFiles(messages, ['output-1']);

    expect(message.attachments).toEqual([sources]);
  });

  it('removes the locator from a content part and a file from a steer part, not the part', () => {
    const content = [
      { type: ContentTypes.TEXT, text: 'Generated:' },
      { type: ContentTypes.IMAGE_FILE, image_file: { file_id: 'image-1' } },
      { type: 'file', file: { file_id: 'kept-1' } },
      { type: ContentTypes.STEER, steer: 'use this instead', files: [upload, kept] },
    ] as unknown as TMessage['content'];
    const messages: Partial<TMessage>[] = [{ messageId: 'assistant-1', content }];

    const [message] = withoutExcludedFiles(messages, ['image-1', upload.file_id]);

    expect(message.content).toEqual([
      { type: ContentTypes.TEXT, text: 'Generated:' },
      { type: ContentTypes.IMAGE_FILE },
      { type: 'file', file: { file_id: 'kept-1' } },
      { type: ContentTypes.STEER, steer: 'use this instead', files: [kept] },
    ]);
    expect(message.content?.[0]).toBe(content?.[0]);
    expect(message.content?.[2]).toBe(content?.[2]);
  });
});

describe('withoutUnsentFiles', () => {
  const kept = { file_id: 'kept-1', filename: 'notes.pdf', type: 'application/pdf' };
  const content = [
    { type: ContentTypes.TEXT, text: 'Generated:' },
    { type: ContentTypes.IMAGE_FILE, image_file: { file_id: 'image-1' } },
    { type: 'file', file: { file_id: 'kept-1' }, file_id: 'direct-1' },
    { type: ContentTypes.STEER, steer: 'use this instead', files: [upload, kept] },
  ] as unknown as TMessage['content'];
  const history: Partial<TMessage>[] = [
    { messageId: 'user-1', text: 'Compare these', files: [upload, kept], tokenCount: 1600 },
    { messageId: 'assistant-1', text: 'Here', attachments: [output], content },
    { messageId: 'user-2', text: 'Thanks' },
  ];

  it('drops every file reference when the endpoint does not send earlier files again', () => {
    const view = withoutUnsentFiles(history, { resendFiles: false, excluded: ['upload-1'] });

    expect(view).toEqual([
      { messageId: 'user-1', text: 'Compare these', tokenCount: 1600 },
      {
        messageId: 'assistant-1',
        text: 'Here',
        content: [
          { type: ContentTypes.TEXT, text: 'Generated:' },
          { type: ContentTypes.IMAGE_FILE },
          { type: 'file' },
          { type: ContentTypes.STEER, steer: 'use this instead' },
        ],
      },
      { messageId: 'user-2', text: 'Thanks' },
    ]);
    expect(history[0].files).toEqual([upload, kept]);
    expect(history[1].content).toBe(content);
  });

  it('drops only the left-out files when earlier files are sent again', () => {
    const view = withoutUnsentFiles(history, { resendFiles: true, excluded: ['upload-1'] });

    expect(view[0].files).toEqual([kept]);
    expect(view[1].attachments).toEqual([output]);
    expect(view[2]).toBe(history[2]);
  });

  it('is the stored messages themselves when files are resent and none is left out', () => {
    expect(withoutUnsentFiles(history, {})).toBe(history);
    expect(withoutUnsentFiles(history, { resendFiles: true, excluded: [] })).toBe(history);
  });

  describe('an attachment-only turn', () => {
    const turn: Partial<TMessage> = {
      messageId: 'upload-turn',
      isCreatedByUser: true,
      text: '',
      files: [upload, kept],
    };

    it.each([
      ['earlier files are not sent again', { resendFiles: false }],
      ['every one of its files is left out', { excluded: ['upload-1', 'kept-1'] }],
    ])('keeps the stand-in when %s', (_case, options) => {
      const [view] = withoutUnsentFiles([turn], options);

      expect(view.text).toBe(ATTACHMENT_ONLY_TEXT);
      expect(view.files ?? []).toEqual([]);
      expect(turn.text).toBe('');
    });

    it('stays empty while one of its files is still sent', () => {
      const [view] = withoutUnsentFiles([turn], { excluded: ['upload-1'] });

      expect(view.text).toBe('');
      expect(view.files).toEqual([kept]);
    });

    it.each([
      ['a turn with text of its own', { text: 'Summarize these' }],
      ['an assistant turn', { isCreatedByUser: false }],
      ['a turn with content parts', { content: [] as TMessage['content'] }],
    ])('leaves the text of %s as it was', (_case, overrides) => {
      const message = { ...turn, ...overrides };
      const [view] = withoutUnsentFiles([message], { resendFiles: false });

      expect(view.text).toBe(message.text);
    });
  });
});

describe('scopeHistoricalReplay', () => {
  const fileIds = ['upload-1', 'kept-1'];
  const steerFileIds = ['steer-1', 'upload-1'];

  it('returns the ids as given, and closes nothing, when no file is left out', () => {
    const scope = scopeHistoricalReplay({ fileIds, steerFileIds, excluded: undefined });

    expect(scope.fileIds).toBe(fileIds);
    expect(scope.steerFileIds).toBe(steerFileIds);
    expect(scope.admitted).toBeUndefined();
    expect(scopeHistoricalReplay({ fileIds, steerFileIds, excluded: [] }).admitted).toBeUndefined();
  });

  it('takes left-out files out of both lists and admits only what is left', () => {
    const scope = scopeHistoricalReplay({ fileIds, steerFileIds, excluded: ['upload-1'] });

    expect(scope.fileIds).toEqual(['kept-1']);
    expect(scope.steerFileIds).toEqual(['steer-1']);
    expect(scope.admitted).toEqual(new Set(['kept-1', 'steer-1']));
  });

  it('admits nothing when every earlier file is left out', () => {
    const scope = scopeHistoricalReplay({
      fileIds,
      steerFileIds,
      excluded: ['upload-1', 'kept-1', 'steer-1'],
    });

    expect(scope.fileIds).toEqual([]);
    expect(scope.steerFileIds).toEqual([]);
    expect(scope.admitted).toEqual(new Set());
  });
});
