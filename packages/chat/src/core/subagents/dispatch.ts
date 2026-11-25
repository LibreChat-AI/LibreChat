import { Constants, ContentTypes } from 'librechat-data-provider';
import type { SubagentIdentity, TMessage } from 'librechat-data-provider';
import { parseSubagentBackgroundHandle } from '../parts';

export type SubagentDispatch = {
  message: TMessage;
  subagentType: string;
  identity?: SubagentIdentity;
  agentId?: string;
  /** The dispatching call's arguments, as stored, for its model-authored intent. */
  args?: string | Record<string, unknown>;
};

type DispatchIndex = {
  /** First dispatch per child thread; continuations reuse the thread id. */
  threads: Map<string, SubagentDispatch>;
  /** Each dispatch by the background task it started. */
  tasks: Map<string, SubagentDispatch>;
};

const indexes = new WeakMap<TMessage[], DispatchIndex>();

function indexDispatches(messages: TMessage[]): DispatchIndex {
  let index = indexes.get(messages);
  if (index == null) {
    index = { threads: new Map(), tasks: new Map() };
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
        if (handle == null) continue;
        const dispatch: SubagentDispatch = {
          message,
          subagentType: handle.subagent_type,
          identity: call.subagentIdentity,
          agentId: part.agentId,
          args,
        };
        if (!index.threads.has(handle.subagent_thread_id)) {
          index.threads.set(handle.subagent_thread_id, dispatch);
        }
        if (!index.tasks.has(handle.background_task_id)) {
          index.tasks.set(handle.background_task_id, dispatch);
        }
      }
    }
    indexes.set(messages, index);
  }
  return index;
}

/** Public transcripts carry dispatch metadata instead of an authenticated child
 *  index. Match the host-issued handle, sharing one scan per transcript snapshot. */
export function findSubagentDispatch(
  messages: TMessage[] | undefined,
  threadId: string | undefined,
): SubagentDispatch | undefined {
  if (messages == null || !threadId) return undefined;
  return indexDispatches(messages).threads.get(threadId);
}

/** The call that started one background task, which a continued thread does not share
 *  with the thread's first dispatch. */
export function findSubagentTaskDispatch(
  messages: TMessage[] | undefined,
  taskId: string | undefined,
): SubagentDispatch | undefined {
  if (messages == null || !taskId) return undefined;
  return indexDispatches(messages).tasks.get(taskId);
}
