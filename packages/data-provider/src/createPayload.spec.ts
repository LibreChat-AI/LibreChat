import type { TSubmission } from './types';
import type { TMessage } from './schemas';
import createPayload from './createPayload';
import { EModelEndpoint } from './schemas';

const previewedResponse = {
  messageId: 'response-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: '',
  content: [
    {
      type: 'tool_call',
      tool_call: {
        id: 'call_1',
        name: 'bash_tool',
        args: '{"command":"make"}',
        output: 'head…tail',
        outputTruncated: true,
        outputLength: 40_000,
      },
    },
  ],
} as unknown as TMessage;

describe('createPayload', () => {
  it.each([
    ['regenerate', { isRegenerate: true }],
    ['continue', { isEdited: true, isContinued: true }],
    ['edit and rerun', { isEdited: true, editedContent: { index: 0, type: 'text', text: 'x' } }],
  ])('never carries cached tool-call content on %s', (_name, flags) => {
    const submission = {
      userMessage: {
        messageId: 'user-1',
        conversationId: 'convo-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        isCreatedByUser: true,
        text: 'build it',
      },
      conversation: { conversationId: 'convo-1', endpoint: EModelEndpoint.agents },
      endpointOption: { endpoint: EModelEndpoint.agents, agent_id: 'agent_1' },
      messages: [previewedResponse],
      initialResponse: previewedResponse,
      ...flags,
    } as unknown as TSubmission;

    const { payload } = createPayload(submission);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('tool_call');
    expect(serialized).not.toContain('outputTruncated');
    expect(payload).not.toHaveProperty('content');
    expect(payload).not.toHaveProperty('messages');
  });
});
