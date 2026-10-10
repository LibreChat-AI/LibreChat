import type { TAttachment, TConversation, TMessage } from 'librechat-data-provider';
import { withoutConversationFiles, withoutMessageFiles } from './files';

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
