import { useId, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Tools } from 'librechat-data-provider';
import { Button, disclosureChevronVariants } from '@librechat/client';
import type { MemoryArtifact, TAttachment } from 'librechat-data-provider';
import { toolPanelSpacingClassName } from './disclosure';
import { useExpandCollapse, useLocalize } from '~/hooks';
import MemoryInfo from './MemoryInfo';
import { cn } from '~/utils';

/** True for a memory attachment with no originating tool call. A call rendered
 *  inline as a `MemoryCall` card already shows the same key, value and outcome,
 *  so counting its attachment here too rendered one mutation twice ("Saved
 *  memory" beside "Updated saved memory"), on reload as well as live. Legacy
 *  attachments carry no `toolCallId` and keep this decoration as their only
 *  surface. */
const isUnlinkedMemoryArtifact = (
  attachment?: TAttachment,
): attachment is TAttachment & { [Tools.memory]: MemoryArtifact } =>
  attachment?.[Tools.memory] != null && !attachment.toolCallId;

/** Layout-gate predicate for callers that arrange around this component
 * (e.g. the thinking-dot nudge). Must stay in agreement with the memo's
 * collection condition inside the component: both key on
 * `isUnlinkedMemoryArtifact`. The component itself guards on its memoized
 * list instead, avoiding a second pass per render. */
export const hasMemoryArtifacts = (attachments?: TAttachment[]): boolean =>
  attachments?.some(isUnlinkedMemoryArtifact) ?? false;

export default function MemoryArtifacts({ attachments }: { attachments?: TAttachment[] }) {
  const contentId = useId();
  const localize = useLocalize();
  const [showInfo, setShowInfo] = useState(false);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(showInfo);

  const { hasErrors, memoryArtifacts } = useMemo(() => {
    let hasErrors = false;
    const result: MemoryArtifact[] = [];

    if (!attachments || attachments.length === 0) {
      return { hasErrors, memoryArtifacts: result };
    }

    for (const attachment of attachments) {
      if (isUnlinkedMemoryArtifact(attachment)) {
        result.push(attachment[Tools.memory]);

        if (!hasErrors && attachment[Tools.memory].type === 'error') {
          hasErrors = true;
        }
      }
    }

    return { hasErrors, memoryArtifacts: result };
  }, [attachments]);

  if (memoryArtifacts.length === 0) {
    return null;
  }

  return (
    <>
      <div className="relative my-1 flex h-5 shrink-0 items-center gap-2.5">
        <Button
          variant="ghost"
          className={cn(
            'group/disclosure h-auto w-full justify-start gap-2 rounded-none p-0 font-normal hover:bg-transparent',
            hasErrors ? 'text-status-error' : 'text-text-secondary',
          )}
          onClick={() => setShowInfo((prev) => !prev)}
          aria-expanded={showInfo}
          aria-controls={contentId}
          aria-label={localize('com_ui_memory_updated')}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="size-4 shrink-0"
            aria-hidden="true"
          >
            <path
              d="M6 3C4.89543 3 4 3.89543 4 5V13C4 14.1046 4.89543 15 6 15L6 3Z"
              fill="currentColor"
            />
            <path
              d="M7 3V15H8.18037L8.4899 13.4523C8.54798 13.1619 8.69071 12.8952 8.90012 12.6858L12.2931 9.29289C12.7644 8.82153 13.3822 8.58583 14 8.58578V3.5C14 3.22386 13.7761 3 13.5 3H7Z"
              fill="currentColor"
            />
            <path
              d="M11.3512 15.5297L9.73505 15.8529C9.38519 15.9229 9.07673 15.6144 9.14671 15.2646L9.46993 13.6484C9.48929 13.5517 9.53687 13.4628 9.60667 13.393L12.9996 10C13.5519 9.44771 14.4473 9.44771 14.9996 10C15.5519 10.5523 15.5519 11.4477 14.9996 12L11.6067 15.393C11.5369 15.4628 11.448 15.5103 11.3512 15.5297Z"
              fill="currentColor"
            />
          </svg>
          <span className="tool-status-text font-medium">
            {hasErrors ? localize('com_ui_memory_error') : localize('com_ui_memory_updated')}
          </span>
          <ChevronDown
            className={cn(
              disclosureChevronVariants({ expanded: showInfo }),
              'size-4 translate-y-[1px]',
            )}
            aria-hidden="true"
          />
        </Button>
      </div>
      <div
        id={contentId}
        style={expandStyle}
        role="group"
        aria-label={localize('com_ui_memory_updated')}
        aria-hidden={!showInfo || undefined}
      >
        <div className="overflow-hidden" ref={expandRef}>
          <div
            className={cn(
              toolPanelSpacingClassName,
              'overflow-hidden rounded-lg border border-border-light bg-surface-secondary',
            )}
          >
            {showInfo && <MemoryInfo key="memory-info" memoryArtifacts={memoryArtifacts} />}
          </div>
        </div>
      </div>
    </>
  );
}
