import type { TAttachment, TFile, TAttachmentMetadata } from 'librechat-data-provider';
import type { ToolArtifactType } from '~/utils/artifacts';
import { detectArtifactTypeFromFile } from '~/utils/artifacts';

export {
  attachmentSalience,
  byEntrySalience,
  bySalience,
  displayFilename,
  isImageAttachment,
  isInternalSandboxArtifact,
  isTextAttachment,
  renderAttachmentKey,
} from '@librechat/chat/components';

/**
 * The artifact MIME type a tool-output attachment maps to, or `null` when the
 * app has no viewer for it. The package row asks the files host, which calls
 * this, so the detector stays an app concern.
 */
export const artifactTypeForAttachment = (attachment: TAttachment): ToolArtifactType | null => {
  const file = attachment as TFile & TAttachmentMetadata;
  return detectArtifactTypeFromFile(file);
};
