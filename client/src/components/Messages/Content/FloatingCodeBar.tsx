import React from 'react';
import { InfoIcon } from 'lucide-react';
import type { CodeBarProps } from '~/common';
import useDownloadCode from '~/components/Messages/Content/useDownloadCode';
import DownloadButton from '~/components/Messages/Content/DownloadButton';
import useCopyCode from '~/components/Messages/Content/useCopyCode';
import CopyButton from '~/components/Messages/Content/CopyButton';
import RunCode from '~/components/Messages/Content/RunCode';
import cn from '~/utils/cn';

interface FloatingCodeBarProps extends CodeBarProps {
  isVisible: boolean;
}

const FloatingCodeBar: React.FC<FloatingCodeBarProps> = React.memo(
  ({ lang, error, codeRef, blockIndex, plugin = null, allowExecution = true, isVisible }) => {
    const { isCopied, buttonRef, handleCopy } = useCopyCode(codeRef);
    const {
      isDownloaded,
      buttonRef: downloadButtonRef,
      handleDownload,
    } = useDownloadCode(codeRef, lang);

    return (
      <div
        className={cn(
          'absolute bottom-2 right-2 flex items-center gap-2 font-sans text-xs text-text-secondary transition-opacity duration-150',
          isVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {plugin === true ? (
          <InfoIcon className="flex h-4 w-4 gap-2 text-text-secondary" />
        ) : (
          <>
            {allowExecution === true && (
              <RunCode lang={lang} codeRef={codeRef} blockIndex={blockIndex} iconOnly />
            )}
            {error !== true && (
              <DownloadButton
                ref={downloadButtonRef}
                isDownloaded={isDownloaded}
                iconOnly
                tabIndex={isVisible ? 0 : -1}
                onClick={handleDownload}
              />
            )}
            <CopyButton
              ref={buttonRef}
              isCopied={isCopied}
              iconOnly
              tabIndex={isVisible ? 0 : -1}
              onClick={handleCopy}
            />
          </>
        )}
      </div>
    );
  },
);

export default FloatingCodeBar;
