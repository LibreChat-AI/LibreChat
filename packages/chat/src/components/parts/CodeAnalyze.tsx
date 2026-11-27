import { Terminal } from 'lucide-react';
import { cn, useLocalize } from '@librechat/client';
import type { JSX } from 'react';
import type { ToolCallPhase } from '../../core/parts/toolCallPhase';
import { useToolExpansion } from '../../react/parts/disclosure';
import useProgress from '../../react/parts/useProgress';
import MarkdownLite from '../markdown/Lite';
import ProgressText from './ProgressText';

export interface CodeAnalyzeProps {
  initialProgress: number;
  /** The Python the code interpreter ran. */
  code: string;
  /** The run's outputs as the Assistants API reports them; the card shows their `logs`. */
  outputs: Record<string, unknown>[];
  onExpand?: () => void;
}

/** The card for an Assistants code-interpreter call: the code it ran and what the run logged. */
export default function CodeAnalyze({
  initialProgress = 0.1,
  code,
  outputs = [],
  onExpand,
}: CodeAnalyzeProps): JSX.Element {
  const localize = useLocalize();
  const progress = useProgress(initialProgress);
  const [showCode, setShowCode] = useToolExpansion(true);

  const handleToggleCode = () => {
    setShowCode(!showCode);
    if (!showCode) {
      onExpand?.();
    }
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
      <div className="relative my-1.5 flex h-5 shrink-0 items-center gap-2.5">
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
                'text-text-secondary size-4 shrink-0',
                phase === 'running' && 'animate-pulse',
              )}
              aria-hidden="true"
            />
          }
        />
      </div>
      {showCode && (
        <div className="code-analyze-block bg-surface-code mt-0.5 mb-3 overflow-hidden rounded-xl">
          <MarkdownLite content={code ? `\`\`\`python\n${code}\n\`\`\`` : ''} />
          {logs && (
            <div className="bg-surface-tertiary p-4 text-xs">
              <div className="text-text-secondary mb-1">{localize('com_ui_result')}</div>
              <div className="prose flex flex-col-reverse">
                <pre dir="ltr" className="text-text-primary! shrink-0">
                  {logs}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
