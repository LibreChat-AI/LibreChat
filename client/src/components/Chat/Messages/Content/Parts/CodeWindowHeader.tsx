import { useRef, useState, useCallback, useEffect } from 'react';
import copy from 'copy-to-clipboard';
import CopyButton from '~/components/Messages/Content/CopyButton';
import LangIcon from '~/components/Messages/Content/LangIcon';
import { useLocalize } from '~/hooks';

interface CodeWindowHeaderProps {
  language: string;
  code: string;
  diffStats?: { additions: number; deletions: number };
}

export default function CodeWindowHeader({ language, code, diffStats }: CodeWindowHeaderProps) {
  const localize = useLocalize();
  const [isCopied, setIsCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(() => {
    setIsCopied(true);
    copy(code.trim(), { format: 'text/plain' });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIsCopied(false), 3000);
  }, [code]);

  return (
    <div className="flex items-center justify-between bg-surface-primary-alt px-1.5 py-1.5 font-sans text-xs text-text-secondary dark:bg-transparent">
      <span className="flex items-center gap-1.5 pl-1.5 text-xs font-medium">
        <LangIcon lang={language} className="size-3.5 shrink-0" />
        {language}
        {diffStats && (
          <>
            <span className="flex items-center gap-1 font-normal tabular-nums" aria-hidden="true">
              <span className="text-status-success">+{diffStats.additions}</span>
              <span className="text-status-error">-{diffStats.deletions}</span>
            </span>
            {/* The glyphs above carry the meaning visually through color and
                sign, which neither reaches a screen reader, so the counts are
                announced as words instead of being dropped. */}
            <span className="sr-only">
              {localize('com_ui_diff_stats', {
                0: String(diffStats.additions),
                1: String(diffStats.deletions),
              })}
            </span>
          </>
        )}
      </span>
      <CopyButton isCopied={isCopied} onClick={handleCopy} label={localize('com_ui_copy_code')} />
    </div>
  );
}
