import { useMemo, useState, useEffect, useCallback } from 'react';
import { Tools } from 'librechat-data-provider';
import ResultSwitcher from '~/components/Messages/Content/ResultSwitcher';
import { useToolCallsMapContext, useMessageContext } from '~/Providers';
/* The module, not the parts barrel: the barrel registers the part renderers, which import the
 * whole markdown stack, and code blocks render on boot-time surfaces such as prompt previews. */
import LogContent from '~/components/Chat/Messages/Content/Parts/LogContent';
import { useLocalize } from '~/hooks';

/** What the runs of one code block printed, newest shown first, with a switcher between runs. */
export default function CodeOutput({ blockIndex }: { blockIndex?: number }) {
  const localize = useLocalize();
  const toolCallsMap = useToolCallsMapContext();
  const { messageId, partIndex } = useMessageContext();
  const key = `${messageId}_${partIndex ?? 0}_${blockIndex ?? 0}_${Tools.execute_code}`;
  const [currentIndex, setCurrentIndex] = useState(0);

  const fetchedToolCalls = toolCallsMap?.[key];
  const [toolCalls, setToolCalls] = useState(toolCallsMap?.[key] ?? null);

  useEffect(() => {
    if (fetchedToolCalls) {
      setToolCalls(fetchedToolCalls);
      setCurrentIndex(fetchedToolCalls.length - 1);
    }
  }, [fetchedToolCalls]);

  const currentToolCall = useMemo(() => toolCalls?.[currentIndex], [toolCalls, currentIndex]);

  const next = useCallback(() => {
    if (toolCalls && currentIndex < toolCalls.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  }, [toolCalls, currentIndex]);

  const previous = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  if (!toolCalls || toolCalls.length === 0) {
    return null;
  }

  return (
    <>
      <div dir="ltr" className="border-border-inset bg-surface-code border-t p-4 text-xs">
        <div className="text-text-secondary text-3xs mb-1 font-medium tracking-wide uppercase">
          {localize('com_ui_output')}
        </div>
        <div className="text-text-primary flex flex-col-reverse">
          <pre className="shrink-0">
            <LogContent
              output={(currentToolCall?.result as string | undefined) ?? ''}
              attachments={currentToolCall?.attachments ?? []}
              renderImages={true}
            />
          </pre>
        </div>
      </div>
      {toolCalls.length > 1 && (
        <ResultSwitcher
          currentIndex={currentIndex}
          totalCount={toolCalls.length}
          onPrevious={previous}
          onNext={next}
        />
      )}
    </>
  );
}
