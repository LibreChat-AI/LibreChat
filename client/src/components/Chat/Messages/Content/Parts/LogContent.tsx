import React, { useMemo } from 'react';
import { isAfter } from 'date-fns';
import { imageExtRegex } from 'librechat-data-provider';
import type { TFile, TAttachment, TAttachmentMetadata } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import {
  artifactTypeForAttachment,
  bySalience,
  byEntrySalience,
  displayFilename,
  isInternalSandboxArtifact,
  isTextAttachment,
  renderAttachmentKey,
} from './attachmentTypes';
import { fileToArtifact, TOOL_ARTIFACT_TYPES } from '~/utils/artifacts';
import Image from '~/components/Chat/Messages/Content/Image';
import ToolMermaidArtifact from './ToolMermaidArtifact';
import ToolArtifactCard from './ToolArtifactCard';
import { useLocalize } from '~/hooks';
import LogLink from './LogLink';

interface PanelEntry {
  attachment: TAttachment;
  artifact: Artifact;
}

interface MermaidEntry {
  attachment: TAttachment;
  text: string;
}

interface LogContentProps {
  output?: string;
  renderImages?: boolean;
  attachments?: TAttachment[];
}

type ImageAttachment = TFile & TAttachmentMetadata;

const LogContent: React.FC<LogContentProps> = ({ output = '', renderImages, attachments }) => {
  const localize = useLocalize();
  const artifactPreviewPending = localize('com_ui_artifact_preview_pending');

  const processedContent = useMemo(() => {
    if (!output) {
      return '';
    }

    const parts = output.split('Generated files:');
    return parts[0].trim();
  }, [output]);

  const {
    imageAttachments,
    textAttachments,
    panelAttachments,
    mermaidAttachments,
    nonInlineAttachments,
  } = useMemo(() => {
    const imageAtts: ImageAttachment[] = [];
    const textAtts: Array<TFile & TAttachmentMetadata> = [];
    const panelAtts: PanelEntry[] = [];
    const mermaidAtts: MermaidEntry[] = [];
    const otherAtts: TAttachment[] = [];

    const now = new Date();
    attachments?.forEach((attachment) => {
      // Sandbox-internal placeholders (`.dirkeep` etc.) are
      // implementation detail — never list them as their own files.
      if (isInternalSandboxArtifact(attachment)) {
        return;
      }
      const fileData = attachment as TFile & TAttachmentMetadata;
      const { filepath = null } = fileData;
      // LogContent uses a looser image check than Attachment.tsx (no
      // width/height requirement) to keep parity with the legacy log surface.
      const isImage = imageExtRegex.test(attachment.filename ?? '') && filepath != null;
      if (isImage) {
        imageAtts.push(attachment as ImageAttachment);
        return;
      }
      // Expired downloads must keep the legacy "download expired" message.
      // Panel cards and the mermaid renderer would otherwise present an
      // active-looking surface backed by a dead link, so route expired
      // entries through `renderAttachment` instead.
      const expiresAt =
        'expiresAt' in attachment && typeof attachment.expiresAt === 'number'
          ? new Date(attachment.expiresAt)
          : null;
      const isExpired = expiresAt != null && isAfter(now, expiresAt);
      if (isExpired) {
        otherAtts.push(attachment);
        return;
      }
      const artType = artifactTypeForAttachment(attachment);
      if (artType === TOOL_ARTIFACT_TYPES.MERMAID) {
        if (fileData.text) {
          mermaidAtts.push({
            attachment,
            text: fileData.text,
          });
        }
        return;
      }
      if (artType != null) {
        const artifact = fileToArtifact(fileData, {
          placeholder: artifactPreviewPending,
          preClassifiedType: artType,
        });
        if (artifact) {
          panelAtts.push({ attachment, artifact });
        }
        return;
      }
      if (isTextAttachment(attachment)) {
        textAtts.push(fileData);
        return;
      }
      otherAtts.push(attachment);
    });

    // Sink empty / placeholder files in each bucket so the user's eye
    // lands on the real artifact first. Stable sort preserves the
    // arrival order among non-empty entries.
    imageAtts.sort(bySalience);
    textAtts.sort(bySalience);
    panelAtts.sort(byEntrySalience);
    mermaidAtts.sort(byEntrySalience);
    otherAtts.sort(bySalience);

    return {
      imageAttachments: renderImages === true ? imageAtts : null,
      textAttachments: textAtts,
      panelAttachments: panelAtts,
      mermaidAttachments: mermaidAtts,
      nonInlineAttachments: otherAtts,
    };
  }, [attachments, renderImages, artifactPreviewPending]);

  const renderAttachment = (file: TAttachment) => {
    const now = new Date();
    const expiresAt =
      'expiresAt' in file && typeof file.expiresAt === 'number' ? new Date(file.expiresAt) : null;
    const isExpired = expiresAt ? isAfter(now, expiresAt) : false;
    const filename = file.filename || '';
    const visibleName = displayFilename(filename);

    if (isExpired) {
      return `${visibleName} ${localize('com_download_expired')}`;
    }

    const fileData = file as TFile & TAttachmentMetadata;
    const filepath = file.filepath || '';

    return (
      <LogLink
        href={filepath}
        filename={filename}
        file_id={fileData.file_id}
        user={fileData.user}
        source={fileData.source}
      >
        {'- '}
        {visibleName} {localize('com_click_to_download')}
      </LogLink>
    );
  };

  return (
    <>
      {processedContent && <div>{processedContent}</div>}
      {nonInlineAttachments.length > 0 && (
        <div>
          <p>{localize('com_generated_files')}</p>
          {nonInlineAttachments.map((file, index) => (
            <React.Fragment key={renderAttachmentKey('nonInline', file, index)}>
              {renderAttachment(file)}
              {index < nonInlineAttachments.length - 1 && ', '}
            </React.Fragment>
          ))}
        </div>
      )}
      {panelAttachments.length > 0 && (
        <div className="mt-2 flex w-full max-w-full flex-col">
          {panelAttachments.map(({ attachment, artifact }, index) => (
            <ToolArtifactCard
              key={renderAttachmentKey('artifact', attachment, index)}
              attachment={attachment}
              artifact={artifact}
            />
          ))}
        </div>
      )}
      {mermaidAttachments.length > 0 && (
        <div className="mt-2 flex flex-col gap-3">
          {mermaidAttachments.map(({ attachment, text }, index) => (
            <ToolMermaidArtifact
              key={renderAttachmentKey('mermaid', attachment, index)}
              attachment={attachment}
              text={text}
            />
          ))}
        </div>
      )}
      {textAttachments.length > 0 && (
        <div className="mt-2 flex flex-col gap-3">
          {textAttachments.map((file, index) => (
            <div
              key={renderAttachmentKey('text', file, index)}
              className="rounded-lg bg-surface-secondary p-3"
            >
              {file.filename && (
                <div className="mb-1 truncate text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                  {file.filepath ? (
                    <LogLink
                      href={file.filepath}
                      filename={file.filename}
                      file_id={file.file_id}
                      user={file.user}
                      source={file.source}
                    >
                      {displayFilename(file.filename)}
                    </LogLink>
                  ) : (
                    displayFilename(file.filename)
                  )}
                </div>
              )}
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-text-primary">
                {file.text}
              </pre>
            </div>
          ))}
        </div>
      )}
      {imageAttachments?.map((attachment, index) => (
        <Image
          width={attachment.width}
          height={attachment.height}
          key={renderAttachmentKey('image', attachment, index)}
          altText={attachment.filename}
          imagePath={attachment.filepath}
        />
      ))}
    </>
  );
};

export default LogContent;
