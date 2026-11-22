import React from 'react';
import { cn } from '@librechat/client';
import { InfoIcon } from 'lucide-react';
import type { CodeBarProps } from './CodeBar';
import useDownloadCode from './useDownloadCode';
import DownloadButton from './DownloadButton';
import useCopyCode from './useCopyCode';
import CopyButton from './CopyButton';

interface FloatingCodeBarProps extends CodeBarProps {
  isVisible: boolean;
}

const FloatingCodeBar: React.NamedExoticComponent<FloatingCodeBarProps> = React.memo(
  ({
    lang,
    error,
    codeRef,
    blockIndex,
    renderRun,
    isVisible,
    plugin = null,
    allowExecution = true,
  }: FloatingCodeBarProps) => {
    const { isCopied, buttonRef, handleCopy } = useCopyCode(codeRef);
    const {
      isDownloaded,
      buttonRef: downloadButtonRef,
      handleDownload,
    } = useDownloadCode(codeRef, lang);

    return (
      <div
        className={cn(
          'text-text-secondary absolute inset-e-2 bottom-2 flex items-center gap-2 font-sans text-xs transition-opacity duration-150',
          isVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {plugin === true ? (
          <InfoIcon className="text-text-secondary flex h-4 w-4 gap-2" />
        ) : (
          <>
            {allowExecution === true && renderRun?.({ lang, codeRef, blockIndex, iconOnly: true })}
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
