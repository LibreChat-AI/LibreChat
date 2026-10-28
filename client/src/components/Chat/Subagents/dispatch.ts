import { Constants, ContentTypes } from 'librechat-data-provider';
import type { SubagentIdentity, TMessage } from 'librechat-data-provider';
import { parseSubagentBackgroundHandle } from '~/components/Chat/Messages/Content/Parts/handle';

type Dispatch = {
  message: TMessage;
  subagentType: string;
  identity?: SubagentIdentity;
  agentId?: string;
};

const indexes = new WeakMap<TMessage[], Map<string, Dispatch>>();

/** Public transcripts carry dispatch metadata instead of an authenticated child
 *  index. Match the host-issued handle, sharing one scan per transcript snapshot. */
export function findSubagentDispatch(
  messages: TMessage[] | undefined,
  threadId: string | undefined,
): Dispatch | undefined {
  if (messages == null || !threadId) return undefined;
  let index = indexes.get(messages);
  if (index == null) {
    index = new Map();
    for (const message of messages) {
      if (message.isCreatedByUser === true) continue;
      for (const part of message.content ?? []) {
        if (part?.type !== ContentTypes.TOOL_CALL) continue;
        const call = part.tool_call;
        if (!('name' in call) && !('function' in call)) continue;
        const name = 'function' in call ? call.function.name : call.name;
        if (name !== Constants.SUBAGENT) continue;
        const output = 'function' in call ? call.function.output : call.output;
        let args: Parameters<typeof parseSubagentBackgroundHandle>[1];
        if ('function' in call) {
          args =
            typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments);
        } else {
          args = call.args;
        }
        const handle = parseSubagentBackgroundHandle(output, args);
        if (handle == null || index.has(handle.subagent_thread_id)) continue;
        index.set(handle.subagent_thread_id, {
          message,
          subagentType: handle.subagent_type,
          identity: call.subagentIdentity,
          agentId: part.agentId,
        });
      }
    }
    indexes.set(messages, index);
  }
  return index.get(threadId);
}
