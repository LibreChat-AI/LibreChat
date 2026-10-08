import { useCallback } from 'react';
import { useStore } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';

export default function useBuildMessageTree() {
  const jotaiStore = useStore();
  const getSiblingIdx = useCallback(
    async (messageId: string | null | undefined) =>
      jotaiStore.get(siblingIdxFamily(siblingKey(messageId))),
    [jotaiStore],
  );

  // return an object or an array based on branches and recursive option
  // messageId is used to get siblindIdx from recoil snapshot
  const buildMessageTree = async ({
    messageId,
    message,
    messages,
    branches = false,
    recursive = false,
  }: {
    messageId: string | null | undefined;
    message: Partial<TMessage> | null;
    messages: Array<Partial<TMessage> | undefined> | null;
    branches?: boolean;
    recursive?: boolean;
  }): Promise<TMessage | Array<Partial<TMessage> | undefined>> => {
    let children: Array<Partial<TMessage> | undefined> = [];
    if (messages?.length != null && messages.length > 0) {
      if (branches) {
        for (const message of messages) {
          children.push(
            (await buildMessageTree({
              messageId: message?.messageId,
              message: message as TMessage,
              messages: message?.children || [],
              branches,
              recursive,
            })) as TMessage,
          );
        }
      } else {
        let message = messages[0];
        if (messages.length > 1) {
          const siblingIdx = await getSiblingIdx(messageId);
          message = messages[messages.length - siblingIdx - 1];
        }

        children = [
          (await buildMessageTree({
            messageId: message?.messageId,
            message: message as TMessage,
            messages: message?.children || [],
            branches,
            recursive,
          })) as TMessage,
        ];
      }
    }

    if (recursive && message) {
      return { ...(message as TMessage), children: children as TMessage[] };
    } else {
      let ret: TMessage[] = [];
      if (message) {
        const _message = { ...message };
        delete _message.children;
        ret = [_message as TMessage];
      }
      for (const child of children) {
        ret = ret.concat(child as TMessage);
      }
      return ret;
    }
  };

  return buildMessageTree;
}
