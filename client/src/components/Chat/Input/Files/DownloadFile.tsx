import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button, Spinner, TooltipAnchor, useToastContext } from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import { getDownloadFilename, triggerDownload } from '~/utils';
import { useAuthContext, useLocalize } from '~/hooks';
import { useFileDownload } from '~/data-provider';

export default function DownloadFile({ file }: { file: TFile }) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const [isDownloading, setIsDownloading] = useState(false);
  const { refetch } = useFileDownload(user?.id, file.file_id, { source: file.source });

  const handleDownload = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDownloading(true);
    try {
      const result = await refetch();
      if (result.isError || !result.data) {
        showToast({ status: 'error', message: localize('com_ui_download_error') });
        return;
      }
      triggerDownload(result.data, getDownloadFilename(file.filename, file.file_id, file.source));
    } catch (error) {
      console.error('Error downloading file:', error);
      showToast({ status: 'error', message: localize('com_ui_download_error') });
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <TooltipAnchor
      description={localize('com_ui_download')}
      render={
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${localize('com_ui_download')} ${file.filename}`}
          aria-busy={isDownloading}
          disabled={isDownloading || !user?.id || !file.file_id}
          onClick={handleDownload}
        >
          {isDownloading ? (
            <Spinner className="size-4" aria-hidden="true" />
          ) : (
            <Download className="size-4" aria-hidden="true" />
          )}
        </Button>
      }
    />
  );
}
