import { memo, useMemo } from 'react';
import type { TAttachment, TFile, TAttachmentMetadata } from 'librechat-data-provider';
import type { AttachmentArtifact } from '@librechat/chat/react';
import type { ReactNode } from 'react';
import { fileToArtifact, isToolArtifactType, TOOL_ARTIFACT_TYPES } from '~/utils/artifacts';
import { artifactTypeForAttachment } from './attachmentTypes';
import ToolMermaidArtifact from './ToolMermaidArtifact';
import ToolArtifactCard from './ToolArtifactCard';
import { useLocalize } from '~/hooks';

/** The viewer a tool-output file opens in, or null when the row should fall through. */
export function classifyAttachment(attachment: TAttachment): AttachmentArtifact | null {
  const type = artifactTypeForAttachment(attachment);
  if (type == null) {
    return null;
  }
  if (type === TOOL_ARTIFACT_TYPES.MERMAID) {
    return { kind: 'mermaid' };
  }
  return { kind: 'panel', artifactType: type };
}

const PanelArtifact = memo(function PanelArtifact({
  attachment,
  artifactType,
}: {
  attachment: TAttachment;
  artifactType: string;
}) {
  const localize = useLocalize();
  const placeholder = localize('com_ui_artifact_preview_pending');
  const artifact = useMemo(() => {
    if (!isToolArtifactType(artifactType)) {
      return null;
    }
    return fileToArtifact(attachment as TFile & TAttachmentMetadata, {
      placeholder,
      preClassifiedType: artifactType,
    });
  }, [attachment, artifactType, placeholder]);
  if (artifact == null) {
    return null;
  }
  return <ToolArtifactCard attachment={attachment} artifact={artifact} />;
});

/** Draws the artifact card or mermaid viewer the classifier named. */
export function renderAttachmentArtifact({
  attachment,
  artifact,
}: {
  attachment: TAttachment;
  artifact: AttachmentArtifact;
}): ReactNode {
  if (artifact.kind === 'mermaid') {
    const file = attachment as TFile & TAttachmentMetadata;
    if (!file.text) {
      return null;
    }
    return <ToolMermaidArtifact attachment={attachment} text={file.text} />;
  }
  return <PanelArtifact attachment={attachment} artifactType={artifact.artifactType} />;
}
