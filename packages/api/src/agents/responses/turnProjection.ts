import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type {
  ResponseTurnWrites,
  StoredResponseRecord,
  ResponseTerminalReceipt,
} from '@librechat/data-schemas';
import type { ResponseTurnIntent } from './foreground';
import type { InternalMessage } from './service';
import type { Response } from './types';
import { projectStoredResponseMessage } from './foreground';
import { convertInputToMessages } from './service';

/** Rebuild canonical writes from immutable request/receipt bytes, without a live request closure. */
export function projectCanonicalResponseTurn(
  record: StoredResponseRecord,
  receipt: ResponseTerminalReceipt,
): ResponseTurnWrites | undefined {
  if (!receipt.turnJSON) return undefined; // Failures before turn preparation have no history to materialize.
  const intent = JSON.parse(receipt.turnJSON) as ResponseTurnIntent;
  if (
    intent.version !== 1 ||
    intent.context.userId !== record.userId ||
    intent.conversation.conversationId !== record.conversationId ||
    intent.conversation.agent_id !== record.agentId ||
    !Array.isArray(intent.inputs) ||
    typeof intent.parentMessageId !== 'string'
  )
    throw new Error('Response turn projection identity changed');
  const request = JSON.parse(record.requestJSON);
  const inputs = convertInputToMessages(request.input);
  if (
    (!record.resume && inputs.length !== intent.inputs.length) ||
    (record.resume && intent.inputs.length !== 0)
  )
    throw new Error('Response input projection changed');
  const response = JSON.parse(receipt.responseJSON) as Response;
  const projectedInputs = intent.inputs.map((layout, index) => {
    if (
      layout.index !== index ||
      !layout.messageId ||
      !layout.parentMessageId ||
      (index > 0 && layout.parentMessageId !== intent.inputs[index - 1].messageId)
    )
      throw new Error('Response input ancestry changed');
    const message: InternalMessage = inputs[index];
    return {
      messageId: layout.messageId,
      parentMessageId: layout.parentMessageId,
      conversationId: record.conversationId,
      isCreatedByUser: message.role === 'user',
      isUserSubmitted: true,
      metadata: { responseInputRole: message.role },
      text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      content:
        typeof message.content === 'string'
          ? [{ type: ContentTypes.TEXT, text: message.content }]
          : message.content,
      sender: { user: 'User', system: 'System', assistant: 'Agent' }[message.role],
      endpoint: EModelEndpoint.agents,
      model: record.agentId,
    };
  });
  if (
    intent.inputs.length &&
    intent.inputs[intent.inputs.length - 1]?.messageId !== intent.parentMessageId
  )
    throw new Error('Response output ancestry changed');
  return {
    intentJSON: receipt.turnJSON,
    context: {
      ...intent.context,
      expiredAt: intent.context.expiredAt ? new Date(intent.context.expiredAt) : undefined,
    },
    conversation: intent.conversation,
    initialAgentId: intent.initialAgentId,
    messages: [
      ...projectedInputs,
      {
        messageId: record.responseId,
        conversationId: record.conversationId,
        ...projectStoredResponseMessage(response, intent.parentMessageId),
        ...intent.trace,
        isCreatedByUser: false,
        sender: 'Agent',
        endpoint: EModelEndpoint.agents,
        model: record.agentId,
        finish_reason: response.status === 'completed' ? 'stop' : response.status,
        tokenCount: intent.visibleOutputTokens ?? response.usage?.output_tokens,
      },
    ],
  };
}
