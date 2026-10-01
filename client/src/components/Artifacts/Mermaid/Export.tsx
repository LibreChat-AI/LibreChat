import React, { memo } from 'react';
import type { ProcessedMermaidSvg } from '~/utils/diagram/export';
import type { Artifact } from '~/common';
import MermaidExport from '~/components/Messages/Content/Mermaid/Export';
import useArtifactDownload from '~/hooks/Artifacts/useArtifactDownload';
import { useLocalize } from '~/hooks';

/**
 * The artifacts panel's single download control for a mermaid diagram.
 *
 * It renders whether or not the preview has produced an SVG yet: SVG and PNG
 * stay disabled until it has, but saving the diagram source never needed a
 * render, and a control that vanishes between the code and preview tabs is
 * worse than one whose items are honestly disabled. Because this menu also
 * owns the source download, the panel does not render `DownloadArtifact`
 * beside it for mermaid.
 */
const ArtifactMermaidExport = memo(function ArtifactMermaidExport({
  artifact,
  exportData,
  portalElement,
}: {
  artifact: Artifact;
  exportData?: ProcessedMermaidSvg | null;
  portalElement?: HTMLElement | null;
}) {
  const localize = useLocalize();
  const { handleDownload } = useArtifactDownload(artifact);

  return (
    <MermaidExport
      key={artifact.id}
      svg={exportData?.svg}
      dimensions={exportData?.dimensions}
      filename={artifact.title ?? localize('com_ui_mermaid_diagram')}
      buttonClassName="h-9 w-9 p-0"
      portalElement={portalElement}
      onDownloadSource={handleDownload}
    />
  );
});

ArtifactMermaidExport.displayName = 'ArtifactMermaidExport';

export default ArtifactMermaidExport;
