import React from 'react';
import { InfoIcon } from 'lucide-react';
import { useLocalize } from '@librechat/client';
import type { ReactNode, RefObject } from 'react';
import useDownloadCode from './useDownloadCode';
import DownloadButton from './DownloadButton';
import useCopyCode from './useCopyCode';
import CopyButton from './CopyButton';
import LangIcon from './LangIcon';

/** What a host's run button is told about the block it runs. */
export interface RunCodeProps {
  lang: string;
  /** The block's `<code>` element, read for its text when the button is pressed. */
  codeRef: RefObject<HTMLElement>;
  blockIndex?: number;
  /** The floating bar's button: the glyph without its label. */
  iconOnly?: boolean;
}

export interface CodeBarProps {
  lang: string;
  error?: boolean;
  plugin?: boolean | null;
  blockIndex?: number;
  allowExecution?: boolean;
  codeRef: RefObject<HTMLElement>;
  /** Draws the run button, for a host that can execute code. Without it the bar has none. */
  renderRun?: (props: RunCodeProps) => ReactNode;
}

const CodeBar: React.NamedExoticComponent<CodeBarProps> = React.memo(
  ({
    lang,
    error,
    codeRef,
    blockIndex,
    renderRun,
    plugin = null,
    allowExecution = true,
  }: CodeBarProps) => {
    const localize = useLocalize();
    const { isCopied, handleCopy } = useCopyCode(codeRef);
    const { isDownloaded, handleDownload } = useDownloadCode(codeRef, lang);

    return (
      <div className="bg-surface-code text-text-secondary flex items-center justify-between px-1.5 py-1.5 font-sans text-xs">
        <span className="flex items-center gap-1.5 ps-1.5 text-xs font-medium">
          <LangIcon lang={lang} className="size-3.5" />
          {lang}
        </span>
        {plugin === true ? (
          <InfoIcon className="text-text-secondary ms-auto flex h-4 w-4 gap-2" />
        ) : (
          <div className="flex items-center justify-center gap-2">
            {allowExecution === true && renderRun?.({ lang, codeRef, blockIndex })}
            {error !== true && (
              <>
                <DownloadButton
                  isDownloaded={isDownloaded}
                  iconOnly
                  onClick={handleDownload}
                  label={localize('com_ui_download_code')}
                />
                <CopyButton
                  isCopied={isCopied}
                  iconOnly
                  onClick={handleCopy}
                  label={localize('com_ui_copy_code')}
                />
              </>
            )}
          </div>
        )}
      </div>
    );
  },
);

export default CodeBar;
