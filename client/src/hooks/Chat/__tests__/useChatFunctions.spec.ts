import { EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, TUser } from 'librechat-data-provider';
import { resolvePayloadPromptPrefix } from '../ask/turn';
import {
  getRegenerateSubmissionMessages,
  getPreliminaryRegenerateResponseMessageId,
  getRegenerateTargetResponseMessage,
} from '../useChatFunctions';

const userMessage = (messageId: string, parentMessageId = '00000000-0000-0000-0000-000000000000') =>
  ({
    messageId,
    parentMessageId,
    isCreatedByUser: true,
    sender: 'User',
    text: messageId,
  }) as TMessage;

const assistantMessage = (messageId: string, parentMessageId: string) =>
  ({
    messageId,
    parentMessageId,
    isCreatedByUser: false,
    sender: 'Assistant',
    text: messageId,
  }) as TMessage;

describe('regenerate response targeting', () => {
  it('uses the clicked assistant response instead of the conversation tail', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
      userMessage('user-3', 'assistant-2'),
      assistantMessage('assistant-3', 'user-3'),
    ];

    const targetResponse = getRegenerateTargetResponseMessage({
      messages,
      parentMessageId: 'user-1',
      targetResponseMessageId: 'assistant-1',
      latestMessage: messages[5],
    });

    expect(targetResponse?.messageId).toBe('assistant-1');
    expect(getPreliminaryRegenerateResponseMessageId(targetResponse?.messageId)).toBe(
      'assistant-1_',
    );
  });

  it('only falls back to latestMessage when it belongs to the regenerated user turn', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
    ];

    expect(
      getRegenerateTargetResponseMessage({
        messages,
        parentMessageId: 'user-1',
        latestMessage: messages[3],
      })?.messageId,
    ).toBe('assistant-1');

    expect(
      getRegenerateTargetResponseMessage({
        messages,
        parentMessageId: 'user-2',
        latestMessage: messages[3],
      })?.messageId,
    ).toBe('assistant-2');
  });

  it('truncates regenerate history before the targeted assistant response', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
      userMessage('user-3', 'assistant-2'),
      assistantMessage('assistant-3', 'user-3'),
    ];

    expect(
      getRegenerateSubmissionMessages({
        messages,
        targetResponseMessage: messages[1],
        initialResponseId: 'assistant-1_',
      }).map((message) => message.messageId),
    ).toEqual(['user-1']);
  });

  it('keeps unrelated sibling branches when regenerating (no flat-array drop)', () => {
    // user-1 has two responses: the original chain (assistant-1 -> ... ) and a
    // regenerated sibling (assistant-1b) that sits LATER in the flat array.
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
      assistantMessage('assistant-1b', 'user-1'),
    ];

    // Regenerating the latest response on the original branch must drop only
    // that response, NOT the unrelated assistant-1b branch.
    expect(
      getRegenerateSubmissionMessages({
        messages,
        targetResponseMessage: messages[3],
        initialResponseId: 'assistant-2_',
      })
        .map((message) => message.messageId)
        .sort(),
    ).toEqual(['assistant-1', 'assistant-1b', 'user-1', 'user-2']);

    // Regenerating an earlier response drops its subtree (user-2, assistant-2)
    // but still keeps the unrelated assistant-1b branch.
    expect(
      getRegenerateSubmissionMessages({
        messages,
        targetResponseMessage: messages[1],
        initialResponseId: 'assistant-1_',
      })
        .map((message) => message.messageId)
        .sort(),
    ).toEqual(['assistant-1b', 'user-1']);
  });
});

describe('resolvePayloadPromptPrefix', () => {
  const user = { name: 'Ada' } as TUser;
  const template = 'Hi {{current_user}}, today is {{current_date}}.';

  it.each([EModelEndpoint.agents, EModelEndpoint.openAI, 'custom-vllm'])(
    'sends the raw template on the agents route (%s) for server-side resolution',
    (endpoint) => {
      expect(resolvePayloadPromptPrefix({ promptPrefix: template, endpoint, user })).toBe(template);
    },
  );

  it('resolves special variables in the browser for assistants endpoints', () => {
    const resolved = resolvePayloadPromptPrefix({
      promptPrefix: template,
      endpoint: EModelEndpoint.assistants,
      user,
    });
    expect(resolved).toMatch(/^Hi Ada, today is \d{4}-\d{2}-\d{2} \(\w+\)\.$/);
  });
});
