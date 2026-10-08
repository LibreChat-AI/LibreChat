import React from 'react';
import { Download } from 'lucide';
import ActionButton from '~/components/Messages/Content/ActionButton';
import { useLocalize } from '~/hooks';

interface DownloadButtonProps {
  isDownloaded: boolean;
  iconOnly?: boolean;
  onClick: () => void;
  tabIndex?: number;
  className?: string;
  label?: string;
  downloadedLabel?: string;
}

const DownloadButton = React.forwardRef<HTMLButtonElement, DownloadButtonProps>(
  (
    { isDownloaded, iconOnly = false, onClick, tabIndex, className, label, downloadedLabel },
    ref,
  ) => {
    const localize = useLocalize();

    return (
      <ActionButton
        ref={ref}
        icon={Download}
        isActive={isDownloaded}
        label={label ?? localize('com_ui_download')}
        activeLabel={downloadedLabel ?? localize('com_ui_downloaded')}
        iconOnly={iconOnly}
        onClick={onClick}
        tabIndex={tabIndex}
        className={className}
      />
    );
  },
);

DownloadButton.displayName = 'DownloadButton';

export default DownloadButton;
