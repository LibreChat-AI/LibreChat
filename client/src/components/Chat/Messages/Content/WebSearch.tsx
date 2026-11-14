import { useContext } from 'react';
import { ToolCall, WebSearch as WebSearchPart } from '@librechat/chat/components';
import type { PartMetadata, TAttachment } from 'librechat-data-provider';
import { FaviconImage } from '~/components/Web/SourceHovercard';
import { StackedFavicons } from '~/components/Web/Sources';
import { HeaderActionSlotContext } from './slot';
import { useSearchContext } from '~/Providers';
import SearchVerticals from './verticals';
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
      renderFavicon={({ domain, className }) => (
        <FaviconImage domain={domain} className={className ?? ''} />
      )}
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
