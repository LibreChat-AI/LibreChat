import { Download, CircleCheckBig } from 'lucide';
import { Button, MorphIcon } from '@librechat/client';
import type { Artifact } from '~/common';
import useArtifactDownload from '~/hooks/Artifacts/useArtifactDownload';
import { useLocalize } from '~/hooks';

const DownloadArtifact = ({ artifact }: { artifact: Artifact }) => {
  const localize = useLocalize();
  const { isDownloaded, handleDownload } = useArtifactDownload(artifact);

  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-9 w-9"
      onClick={handleDownload}
      aria-label={localize('com_ui_download_artifact')}
    >
      <MorphIcon icon={isDownloaded ? CircleCheckBig : Download} size={16} />
    </Button>
  );
};

export default DownloadArtifact;
