import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CSSTransition } from 'react-transition-group';
import { setDefaultSubagentsHost } from '@librechat/chat/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { SteerPart, ScrollToBottom } from '@librechat/chat/components';
import type {
  SubagentsHost,
  TaskContentScope,
  SubagentRetainedControl,
  SubagentJumpToLatestProps,
} from '@librechat/chat/react';

/** Reads a shortened guidance message's full receipt, once the reader asks for it. */
function useRetainedControl(
  scope: TaskContentScope,
  invocationId: string,
  enabled: boolean,
): SubagentRetainedControl {
  const query = useQuery(
    [
      QueryKeys.subagentControlReceipt,
      scope.parentConversationId,
      scope.threadId,
      scope.taskId,
      invocationId,
    ],
    async () => {
      const response = await dataService.getSubagentControlReceipt(
        scope.parentConversationId,
        scope.threadId,
        scope.taskId,
        invocationId,
      );
      if (response.receipt.invocationId !== invocationId)
        throw new Error('subagent_control_identity_mismatch');
      return response;
    },
    { enabled, retry: 1, staleTime: Infinity, refetchOnWindowFocus: false },
  );
  return {
    message: query.data?.receipt.message,
    isFetching: query.isFetching,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

/** The transcript's jump-to-latest control with the app's fade: the button takes pointers and
 *  focus only once the enter transition has settled. */
function JumpToLatest({ visible, onClick, maximizeChatSpace }: SubagentJumpToLatestProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isSettled, setIsSettled] = useState(false);
  return (
    <CSSTransition
      in={visible}
      timeout={{ enter: 300, exit: 180 }}
      classNames="scroll-animation"
      unmountOnExit={true}
      appear={true}
      nodeRef={ref}
      onEntered={() => setIsSettled(true)}
      onExit={() => setIsSettled(false)}
    >
      <ScrollToBottom
        ref={ref}
        scrollHandler={onClick}
        maximizeChatSpace={maximizeChatSpace}
        interactive={isSettled}
      />
    </CSSTransition>
  );
}

/** What subagent transcripts read from the app: the steer renderer and the jump-to-latest fade
 *  that still live here, and the receipt read. Registered as the default when this module loads. */
export const appSubagentsHost: SubagentsHost = {
  renderSteer: (props) => <SteerPart {...props} />,
  renderJumpToLatest: (props) => <JumpToLatest {...props} />,
  useRetainedControl,
};

setDefaultSubagentsHost(appSubagentsHost);
