import React from 'react';
import { InfoIcon } from 'lucide-react';
import type { CodeBarProps } from '~/common';
import useDownloadCode from '~/components/Messages/Content/useDownloadCode';
import DownloadButton from '~/components/Messages/Content/DownloadButton';
import useCopyCode from '~/components/Messages/Content/useCopyCode';
import CopyButton from '~/components/Messages/Content/CopyButton';
import LangIcon from '~/components/Messages/Content/LangIcon';
import RunCode from '~/components/Messages/Content/RunCode';
import { useLocalize } from '~/hooks';

const CodeBar: React.FC<CodeBarProps> = React.memo(
  ({ lang, error, codeRef, blockIndex, plugin = null, allowExecution = true }) => {
    const localize = useLocalize();
    const { isCopied, handleCopy } = useCopyCode(codeRef);
    const { isDownloaded, handleDownload } = useDownloadCode(codeRef, lang);

    return (
      <div className="bg-surface-code text-text-secondary flex items-center justify-between px-1.5 py-1.5 font-sans text-xs">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <LangIcon lang={lang} className="size-3.5" />
          {lang}
        </span>
        {plugin === true ? (
          <InfoIcon className="text-text-secondary ml-auto flex h-4 w-4 gap-2" />
        ) : (
          <div className="flex items-center justify-center gap-2">
            {allowExecution === true && (
              <RunCode lang={lang} codeRef={codeRef} blockIndex={blockIndex} />
            )}
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
