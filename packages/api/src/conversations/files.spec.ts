import { ContentTypes } from 'librechat-data-provider';
import type { TAttachment, TConversation, TMessage } from 'librechat-data-provider';
import { forkFileScope, withoutMessageFiles, withoutConversationFiles } from './files';

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
    const conversation: Partial<TConversation> & { files?: string[] } = {
      conversationId: 'convo-1',
      title: 'Screenshots',
      model: 'gpt-4o',
      files: ['upload-1'],
      file_ids: ['legacy-1'],
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
