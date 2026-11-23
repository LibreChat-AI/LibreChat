import { useContext } from 'react';
import {
  ToolCall,
  SearchVerticals,
  HeaderActionSlotContext,
  WebSearch as WebSearchPart,
} from '@librechat/chat/components';
import type { PartMetadata, TAttachment } from 'librechat-data-provider';
import { StackedFavicons } from '~/components/Web/Sources';
import { useSearchContext } from '~/Providers';
import './toolCallSlots';

export default function WebSearch({
  isLast,
  isSubmitting,
  args,
  output,
  initialProgress,
  attachments,
  hideAttachments,
  onExpand,
  runStepStatus,
}: {
  isLast?: boolean;
  isSubmitting: boolean;
  args?: string | Record<string, unknown>;
  output?: string | null;
  initialProgress: number;
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  onExpand?: () => void;
  runStepStatus?: PartMetadata['runStepStatus'];
}) {
  const { searchResults } = useSearchContext();
  const headerSlot = useContext(HeaderActionSlotContext);
  return (
    <WebSearchPart
      initialProgress={initialProgress}
      isSubmitting={isSubmitting}
      isLast={isLast}
      args={args}
      output={output}
      attachments={attachments}
      hideAttachments={hideAttachments}
      onExpand={onExpand}
      runStepStatus={runStepStatus}
      searchResults={searchResults}
      headerSlot={headerSlot}
      renderStackedFavicons={({ sources, start }) => (
        <StackedFavicons sources={sources} start={start} />
      )}
      renderVerticals={(verticalAttachments) => (
        <SearchVerticals attachments={verticalAttachments} />
      )}
      renderFailedCall={(failed) => <ToolCall {...failed} />}
    />
  );
}
