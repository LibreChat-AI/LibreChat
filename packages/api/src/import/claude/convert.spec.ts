import { Constants, ContentTypes } from 'librechat-data-provider';
import type { ClaudeMessage, ClaudeConversation, ConvertedMessage } from '~/import/types';
import { CLAUDE_ROOT_UUID } from '~/import/__data__/claude';
import { convertClaudeConversation } from './convert';

const OPTIONS = { defaultModel: 'claude-opus-4-7' };

function conversation(messages: ClaudeMessage[], uuid = 'conv-1'): ClaudeConversation {
  return {
    uuid,
    name: 'Fixture',
    created_at: '2025-12-08T17:00:00.000Z',
    updated_at: '2025-12-08T17:05:00.000Z',
    chat_messages: messages,
  };
}

function textMessage(
  uuid: string,
  parent: string | null,
  sender: string,
  text: string,
  seconds = 1,
): ClaudeMessage {
  return {
    uuid,
    sender,
    parent_message_uuid: parent,
    created_at: `2025-12-08T17:00:${String(seconds).padStart(2, '0')}.000Z`,
    content: [{ type: 'text', text }],
  };
}

function byText(messages: ConvertedMessage[], text: string): ConvertedMessage {
  const found = messages.find((message) => message.text === text);
  if (!found) {
    throw new Error(`no converted message with text ${text}`);
  }
  return found;
}

describe('convertClaudeConversation', () => {
  it('preserves a branch as two children of one parent', () => {
    const converted = convertClaudeConversation(
      conversation([
        textMessage('m1', CLAUDE_ROOT_UUID, 'human', 'Which town?', 1),
        textMessage('m2a', 'm1', 'assistant', 'Positano.', 2),
        textMessage('m2b', 'm1', 'assistant', 'Ravello.', 3),
        textMessage('m3', 'm2b', 'human', 'Why Ravello?', 4),
      ]),
      OPTIONS,
    );

    const root = byText(converted.messages, 'Which town?');
    const first = byText(converted.messages, 'Positano.');
    const second = byText(converted.messages, 'Ravello.');
    const follow = byText(converted.messages, 'Why Ravello?');

    expect(root.parentMessageId).toBe(Constants.NO_PARENT);
    expect(first.parentMessageId).toBe(root.messageId);
    expect(second.parentMessageId).toBe(root.messageId);
    expect(follow.parentMessageId).toBe(second.messageId);
  });

  it('roots a message whose parent uuid is the export sentinel or null', () => {
    const converted = convertClaudeConversation(
      conversation([
        textMessage('m1', CLAUDE_ROOT_UUID, 'human', 'Sentinel root', 1),
        textMessage('m2', null, 'human', 'Null root', 2),
      ]),
      OPTIONS,
    );

    expect(byText(converted.messages, 'Sentinel root').parentMessageId).toBe(Constants.NO_PARENT);
    expect(byText(converted.messages, 'Null root').parentMessageId).toBe(Constants.NO_PARENT);
  });

  it('keeps a message that has tool blocks but no text', () => {
    const converted = convertClaudeConversation(
      conversation([
        textMessage('m1', null, 'human', 'Run it', 1),
        {
          uuid: 'm2',
          sender: 'assistant',
          parent_message_uuid: 'm1',
          created_at: '2025-12-08T17:00:02.000Z',
          text: '',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'bash_tool', input: { command: 'ls' } },
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              name: 'bash_tool',
              content: [{ type: 'text', text: 'src' }],
            },
          ],
        },
        textMessage('m3', 'm2', 'human', 'Thanks', 3),
      ]),
      OPTIONS,
    );

    expect(converted.messages).toHaveLength(3);
    const toolMessage = converted.messages.find((message) => message.text === '');
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toHaveLength(1);
    expect(toolMessage?.content?.[0].type).toBe(ContentTypes.TOOL_CALL);
    expect(byText(converted.messages, 'Thanks').parentMessageId).toBe(toolMessage?.messageId);
  });

  it('drops a contentless message and re-parents its child onto the nearest kept ancestor', () => {
    const converted = convertClaudeConversation(
      conversation([
        textMessage('m1', null, 'human', 'Kept root', 1),
        {
          uuid: 'm2',
          sender: 'human',
          parent_message_uuid: 'm1',
          created_at: '2025-12-08T17:00:02.000Z',
          text: '',
          content: [],
          files: [{ file_uuid: 'f-1', file_name: 'diagram.png' }],
        },
        textMessage('m3', 'm2', 'assistant', 'Reply', 3),
      ]),
      OPTIONS,
    );

    expect(converted.messages).toHaveLength(2);
    expect(byText(converted.messages, 'Reply').parentMessageId).toBe(
      byText(converted.messages, 'Kept root').messageId,
    );
    expect(converted.unavailable).toBe(1);
  });

  it('fences an attachment extraction into the message and counts it as imported', () => {
    const converted = convertClaudeConversation(
      conversation([
        {
          uuid: 'm1',
          sender: 'human',
          parent_message_uuid: null,
          created_at: '2025-12-08T17:00:01.000Z',
          text: '',
          content: [{ type: 'text', text: 'Review this' }],
          attachments: [
            {
              file_name: 'Registration.tsx',
              file_type: 'text/plain',
              file_size: 30,
              extracted_content: 'export const Registration = () => null;',
            },
            { file_name: 'photo.png', file_type: 'image/png', file_size: 4096 },
          ],
        },
      ]),
      OPTIONS,
    );

    expect(converted.messages[0].text).toBe(
      'Review this\n\n```\nRegistration.tsx\nexport const Registration = () => null;\n```',
    );
    expect(converted.extracted).toBe(1);
    expect(converted.unavailable).toBe(1);
  });

  it('recovers a message whose blocks are empty but whose flat text field is not', () => {
    const converted = convertClaudeConversation(
      conversation([
        {
          uuid: 'm1',
          sender: 'assistant',
          parent_message_uuid: null,
          created_at: '2025-12-08T17:00:01.000Z',
          text: 'Only in the flat field.',
          content: [],
        },
      ]),
      OPTIONS,
    );

    expect(converted.messages).toHaveLength(1);
    expect(converted.messages[0].text).toBe('Only in the flat field.');
    expect(converted.messages[0].content).toBeUndefined();
  });

  it('emits reasoning as a think part ahead of the answer text', () => {
    const converted = convertClaudeConversation(
      conversation([
        {
          uuid: 'm1',
          sender: 'assistant',
          parent_message_uuid: null,
          created_at: '2025-12-08T17:00:01.000Z',
          content: [
            { type: 'thinking', thinking: '', summaries: [{ summary: 'Weighing options.' }] },
            { type: 'text', text: 'Positano.' },
            { type: 'token_budget' },
          ],
        },
      ]),
      OPTIONS,
    );

    expect(converted.messages[0].content).toEqual([
      { type: 'think', think: 'Weighing options.' },
      { type: 'text', text: 'Positano.' },
    ]);
  });

  it('attaches the merged web sources cited anywhere in the message', () => {
    const converted = convertClaudeConversation(
      conversation([
        {
          uuid: 'm1',
          sender: 'assistant',
          parent_message_uuid: null,
          created_at: '2025-12-08T17:00:01.000Z',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'web_search', input: { query: 'redis' } },
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              name: 'web_search',
              content: [
                {
                  type: 'knowledge',
                  title: 'Redis Guide',
                  url: 'https://a.example/redis',
                  text: 'Set REDIS_URI.',
                },
              ],
            },
            {
              type: 'text',
              text: 'Set the URI.',
              citations: [
                {
                  uuid: 'c-1',
                  start_index: 0,
                  end_index: 12,
                  details: { type: 'web_search_citation', url: 'https://a.example/redis' },
                },
              ],
            },
          ],
        },
      ]),
      OPTIONS,
    );

    const [message] = converted.messages;
    expect(message.attachments).toEqual([
      {
        type: 'web_search',
        web_search: {
          turn: 0,
          organic: [{ link: 'https://a.example/redis', title: 'Redis Guide' }],
        },
      },
    ]);
    expect(message.text).toContain('turn0search0');
  });

  it('roots a message that is its own ancestor rather than emitting a cycle', () => {
    const converted = convertClaudeConversation(
      conversation([
        { ...textMessage('m1', 'm2', 'human', 'First', 1) },
        { ...textMessage('m2', 'm1', 'assistant', 'Second', 2) },
      ]),
      OPTIONS,
    );

    const roots = converted.messages.filter(
      (message) => message.parentMessageId === Constants.NO_PARENT,
    );
    expect(roots).toHaveLength(1);
  });

  it('pushes a child past a parent whose timestamp is later', () => {
    const converted = convertClaudeConversation(
      conversation([
        textMessage('m1', null, 'human', 'Parent', 9),
        textMessage('m2', 'm1', 'assistant', 'Child', 1),
      ]),
      OPTIONS,
    );

    const parent = byText(converted.messages, 'Parent');
    const child = byText(converted.messages, 'Child');
    expect(child.createdAt.getTime()).toBeGreaterThan(parent.createdAt.getTime());
  });

  it('carries the conversation metadata an import needs to dedupe and render', () => {
    const converted = convertClaudeConversation(
      conversation([textMessage('m1', null, 'human', 'Hello', 1)], 'conv-external'),
      OPTIONS,
    );

    expect(converted.externalId).toBe('conv-external');
    expect(converted.title).toBe('Fixture');
    expect(converted.model).toBe('claude-opus-4-7');
    expect(converted.isArchived).toBe(false);
    expect(converted.pinned).toBe(false);
    expect(converted.messages[0].sender).toBe('user');
    expect(converted.messages[0].isCreatedByUser).toBe(true);
    expect(converted.messages[0].model).toBe('claude-opus-4-7');
  });

  it('falls back to a default title and the conversation time for undated messages', () => {
    const converted = convertClaudeConversation(
      {
        uuid: 'conv-2',
        name: '',
        created_at: '2025-12-08T17:00:00.000Z',
        chat_messages: [
          {
            uuid: 'm1',
            sender: 'assistant',
            parent_message_uuid: null,
            created_at: 'not-a-date',
            content: [{ type: 'text', text: 'Hello' }],
          },
        ],
      },
      OPTIONS,
    );

    expect(converted.title).toBe('Imported Claude Chat');
    expect(converted.messages[0].createdAt.toISOString()).toBe('2025-12-08T17:00:00.000Z');
  });

  it('chains messages in array order when the export carries no parent uuids at all', () => {
    const converted = convertClaudeConversation(
      conversation([
        {
          uuid: 'm1',
          sender: 'human',
          created_at: '2025-12-08T17:00:05.000Z',
          content: [{ type: 'text', text: 'First' }],
        },
        {
          uuid: 'm2',
          sender: 'assistant',
          created_at: '2025-12-08T17:00:02.000Z',
          content: [{ type: 'text', text: 'Second' }],
        },
      ]),
      OPTIONS,
    );

    const first = byText(converted.messages, 'First');
    const second = byText(converted.messages, 'Second');
    expect(first.parentMessageId).toBe(Constants.NO_PARENT);
    expect(second.parentMessageId).toBe(first.messageId);
    expect(second.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
  });

  it('returns no messages for a conversation with an empty message list', () => {
    const converted = convertClaudeConversation({ uuid: 'conv-3', chat_messages: [] }, OPTIONS);
    expect(converted.messages).toHaveLength(0);
  });
});
