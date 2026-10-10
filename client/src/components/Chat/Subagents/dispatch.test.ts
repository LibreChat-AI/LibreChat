import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { findSubagentDispatch } from './dispatch';

const output = JSON.stringify({
  background_task_id: 'task',
  subagent_thread_id: 'thread',
  tool: 'subagent',
  subagent_type: 'self',
  status: 'running',
  message: 'Poll using background_task_id task.',
});

it.each([false, true])(
  'resolves historical dispatch metadata (function format: %s)',
  (functional) => {
    const identity = { subagentKind: 'graph' as const, subagentAgentId: 'graph:self' };
    const message: TMessage = {
      messageId: 'dispatch',
      parentMessageId: null,
      conversationId: 'parent',
      isCreatedByUser: false,
      text: '',
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: functional
            ? {
                id: 'call',
                type: 'function',
                function: { name: 'subagent', arguments: { run_in_background: true }, output },
                subagentIdentity: identity,
              }
            : {
                name: 'subagent',
                args: { run_in_background: true },
                output,
                subagentIdentity: identity,
              },
        },
      ],
    };
    const messages = [message];
    const scan = jest.spyOn(messages, Symbol.iterator);
    expect(findSubagentDispatch(messages, 'thread')).toEqual({
      message,
      identity,
      subagentType: 'self',
    });
    expect(findSubagentDispatch(messages, 'thread')?.message).toBe(message);
    expect(findSubagentDispatch(messages, 'absent')).toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(findSubagentDispatch([{ ...message, isCreatedByUser: true }], 'thread')).toBeUndefined();
    expect(
      findSubagentDispatch(
        [
          {
            ...message,
            content: [
              { type: ContentTypes.TOOL_CALL, tool_call: { name: 'subagent', args: {}, output } },
            ],
          },
        ],
        'thread',
      ),
    ).toBeUndefined();
  },
);
