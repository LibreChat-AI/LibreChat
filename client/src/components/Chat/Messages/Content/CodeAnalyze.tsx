import { useState, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { Terminal } from 'lucide-react';
import type { ToolCallPhase } from '~/utils/toolCallPhase';
import { useProgress, useLocalize } from '~/hooks';
import ProgressText from './ProgressText';
import MarkdownLite from './MarkdownLite';
import { cn } from '~/utils';
import store from '~/store';

export default function CodeAnalyze({
  initialProgress = 0.1,
  code,
  outputs = [],
  onExpand,
}: {
  initialProgress: number;
  code: string;
  outputs: Record<string, unknown>[];
  onExpand?: () => void;
}) {
  const localize = useLocalize();
  const progress = useProgress(initialProgress);
  const autoExpand = useRecoilValue(store.autoExpandTools);
  const [showCode, setShowCode] = useState(autoExpand);

  useEffect(() => {
    if (autoExpand) {
      setShowCode(true);
    }
  }, [autoExpand]);

  const handleToggleCode = () => {
    setShowCode((prev) => {
      const next = !prev;
      if (next) {
        onExpand?.();
      }
      return next;
    });
  };

  const logs = outputs.reduce((acc, output) => {
    if (output['logs']) {
      return acc + output['logs'] + '\n';
    }
    return acc;
  }, '');

  /**
   * The legacy assistants-endpoint card: it never receives run-step metadata,
   * so it genuinely has only these two states and maps them directly rather
   * than through `resolveToolCallPhase`, which needs signals this card has no
   * access to. The announcement and the icon below read this same value.
   */
  const phase: ToolCallPhase = progress < 1 ? 'running' : 'completed';

  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {phase === 'running' ? localize('com_ui_analyzing') : localize('com_ui_analyzing_finished')}
      </span>
      <div className="relative my-1 flex h-5 shrink-0 items-center gap-2.5">
        <ProgressText
          phase={phase}
          onClick={handleToggleCode}
          inProgressText={localize('com_ui_analyzing')}
          finishedText={localize('com_ui_analyzing_finished')}
          hasInput={!!code.length}
          isExpanded={showCode}
          icon={
            <Terminal
              className={cn(
                'size-4 shrink-0 text-text-secondary',
                phase === 'running' && 'animate-pulse',
              )}
              aria-hidden="true"
            />
          }
        />
      </div>
      {showCode && (
        <div className="code-analyze-block mb-3 mt-0.5 overflow-hidden rounded-xl bg-black">
          <MarkdownLite content={code ? `\`\`\`python\n${code}\n\`\`\`` : ''} />
          {logs && (
            <div className="bg-gray-700 p-4 text-xs">
              <div className="mb-1 text-gray-400">{localize('com_ui_result')}</div>
              <div
                className="prose flex flex-col-reverse text-white"
                style={{
                  color: 'white',
                }}
              >
                <pre className="shrink-0">{logs}</pre>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
