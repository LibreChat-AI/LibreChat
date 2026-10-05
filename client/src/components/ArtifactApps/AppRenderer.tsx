import { useRef } from 'react';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react/unstyled';
import type { TArtifactVersion } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { ArtifactPreview } from '~/components/Artifacts/ArtifactPreview';
import useArtifactProps from '~/hooks/Artifacts/useArtifactProps';
import { useGetStartupConfig } from '~/data-provider';
import { getArtifactMimeType } from './runtime';

export default function AppRenderer({
  title,
  version,
}: {
  title: string;
  version: TArtifactVersion;
}) {
  const previewRef = useRef<SandpackPreviewRef>(null as unknown as SandpackPreviewRef);
  const { data: startupConfig } = useGetStartupConfig();

  const artifact: Artifact = {
    id: version.artifactVersionId,
    lastUpdateTime: Date.now(),
    type: getArtifactMimeType(version.artifactType),
    content: version.sourceSnapshot,
    title,
  };

  const { files, fileKey, template, sharedProps } = useArtifactProps({ artifact });

  return (
    <div className="h-full w-full overflow-hidden" role="region" aria-label={title}>
      <ArtifactPreview
        files={files}
        fileKey={fileKey}
        template={template}
        previewRef={previewRef}
        sharedProps={sharedProps}
        startupConfig={startupConfig}
      />
    </div>
  );
}
