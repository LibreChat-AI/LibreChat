import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Tools } from 'librechat-data-provider';
import { useLocalize, useRemScale } from '@librechat/client';
import { Loader2, AlertCircle, Download, ChevronDown, Files as FilesIcon } from 'lucide-react';
import type { TAttachment, TFile, TAttachmentMetadata } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { AttachmentArtifact } from '../../react/files';
import {
  bySalience,
  byEntrySalience,
  displayFilename,
  isImageAttachment,
  isInternalSandboxArtifact,
  isTextAttachment,
  renderAttachmentKey,
} from './attachmentTypes';
import { ARTIFACT_ROW_NAV_SPACING, ROW_GLYPH_SLOT, TOOL_ROW_CLASSES } from './rows';
import FileContainer from '../composer/files/FileContainer';
import { useMessagePartsHost } from '../../react/host';
import useExpandCollapse from './useExpandCollapse';
import { useFilesHost } from '../../react/files';

const PLACEHOLDER_ROW_CLASS = `${TOOL_ROW_CLASSES} ${ARTIFACT_ROW_NAV_SPACING} text-text-secondary text-sm`;

const COLLAPSED_MAX_HEIGHT = 320;
const OVERFLOW_TOLERANCE = 1;

/**
 * Row placeholder for a code-execution office file whose inline preview
 * is still rendering (or failed). Takes `ArtifactRow`'s exact box, same
 * glyph slot, title, and trailing download, so when the deferred render
 * lands and the routing upgrades to the real `PanelArtifact` the row
 * stays put instead of the list reflowing around a new shape.
 *
 * Non-interactive in both states: while pending there is no panel to
 * open yet, and on `'failed'` extraction never produced anything to
 * render, so download is the only meaningful action. Status reads from
 * the spinner / alert glyph plus the trailing text.
 */
const PreviewPlaceholderRow = memo(
  ({
    attachment,
    status,
    previewError,
  }: {
    attachment: Partial<TAttachment>;
    status: 'pending' | 'failed';
    previewError?: string;
  }) => {
    const localize = useLocalize();
    const file = attachment as TFile & TAttachmentMetadata;
    const handleDownload = useFilesHost().useAttachmentDownload({
      href: attachment.filepath ?? '',
      filename: attachment.filename ?? '',
      fileId: file.file_id,
      user: file.user,
      source: file.source,
    });
    const visibleFilename = displayFilename(attachment.filename);
    const subtitleText =
      status === 'pending'
        ? localize('com_ui_preview_preparing')
        : localize('com_ui_preview_failed');
    return (
      <div className={PLACEHOLDER_ROW_CLASS}>
        <span className={ROW_GLYPH_SLOT} aria-hidden="true">
          {status === 'pending' ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : (
            <AlertCircle className="size-4 shrink-0" />
          )}
        </span>
        <span
          className="min-w-0 truncate font-medium"
          title={status === 'failed' ? (previewError ?? subtitleText) : visibleFilename}
          aria-busy={status === 'pending'}
        >
          {visibleFilename}
        </span>
        <span className="min-w-0 shrink-[100] truncate text-xs font-normal">{subtitleText}</span>
        <button
          type="button"
          onClick={handleDownload}
          aria-label={`${localize('com_ui_download')} ${visibleFilename}`}
          className="text-text-secondary ring-offset-surface-primary hover:bg-surface-hover hover:text-text-primary hover:active:bg-surface-pressed focus-visible:ring-focus-control duration-theme-fast inline-flex size-5 shrink-0 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-0 focus-visible:outline-hidden"
        >
          <Download className="size-4" aria-hidden="true" />
        </button>
      </div>
    );
  },
);
PreviewPlaceholderRow.displayName = 'PreviewPlaceholderRow';

const FileAttachment = memo(({ attachment }: { attachment: Partial<TAttachment> }) => {
  const [isVisible, setIsVisible] = useState(false);
  const file = attachment as TFile & TAttachmentMetadata;
  const { useAttachmentDownload, useAttachmentPreview } = useFilesHost();
  const handleDownload = useAttachmentDownload({
    href: attachment.filepath ?? '',
    filename: attachment.filename ?? '',
    fileId: file.file_id,
    user: file.user,
    source: file.source,
  });
  const extension = attachment.filename?.split('.').pop();
  /* Bridge the deferred-preview lifecycle: poll the backend for the
   * resolved record while the file is still pending. The hook is a
   * no-op for terminal states (legacy records, ready, failed
   * already-known) so calling it unconditionally is cheap. */
  const { status: previewStatus, previewError } = useAttachmentPreview(attachment as TAttachment);

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  if (!attachment.filepath) {
    return null;
  }
  /* Pending or failed: render the card-shaped placeholder rather than
   * the small file chip. Visual continuity with `ToolArtifactCard` so
   * when the deferred render lands and the routing upgrades to
   * `PanelArtifact`, the user sees a smooth card→card transition
   * instead of a jump from "file download" to "artifact card". */
  if (previewStatus === 'pending' || previewStatus === 'failed') {
    return (
      <div
        className={
          isVisible
            ? 'attachment-settle w-full min-w-0 translate-y-0 subpixel-antialiased opacity-100 transition-all duration-300 ease-out'
            : 'attachment-settle w-full min-w-0 translate-y-2 subpixel-antialiased opacity-0 transition-all duration-300 ease-out'
        }
      >
        <PreviewPlaceholderRow
          attachment={attachment}
          status={previewStatus}
          previewError={previewError}
        />
      </div>
    );
  }
  return (
    <div
      className={
        isVisible
          ? 'attachment-settle translate-y-0 subpixel-antialiased opacity-100 transition-all duration-300 ease-out'
          : 'attachment-settle translate-y-2 subpixel-antialiased opacity-0 transition-all duration-300 ease-out'
      }
    >
      <FileContainer
        file={attachment}
        onClick={handleDownload}
        overrideType={extension}
        displayName={displayFilename(attachment.filename)}
        containerClassName="max-w-fit"
        buttonClassName="bg-surface-secondary hover:cursor-pointer hover:bg-surface-hover active:bg-surface-secondary focus:bg-surface-hover hover:border-border-heavy active:border-border-heavy"
      />
    </div>
  );
});

const FileAttachmentGroup = memo(({ attachments }: { attachments: TAttachment[] }) => {
  const localize = useLocalize();
  const panelId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const { ref: expandRef } = useExpandCollapse(isExpanded);
  const visibleAttachments = useMemo(
    () => attachments.filter((attachment) => Boolean(attachment.filepath)),
    [attachments],
  );
  const count = visibleAttachments.length;
  const summary = useMemo(() => {
    const names = visibleAttachments.map((attachment) => displayFilename(attachment.filename));
    if (names.length <= 2) {
      return names.join(', ');
    }
    return `${names.slice(0, 2).join(', ')} ${localize('com_ui_plus_n_more', {
      0: String(names.length - 2),
    })}`;
  }, [visibleAttachments, localize]);
  const groupedAttachments = useMemo(() => {
    const files: TAttachment[] = [];
    const textPreviews: TAttachment[] = [];
    for (const attachment of visibleAttachments) {
      if (isTextAttachment(attachment)) {
        textPreviews.push(attachment);
        continue;
      }
      files.push(attachment);
    }
    return { files, textPreviews };
  }, [visibleAttachments]);

  if (count === 0) {
    return null;
  }

  if (count === 1) {
    const [attachment] = visibleAttachments;
    if (!attachment) {
      return null;
    }
    return (
      <div className="my-2 flex flex-wrap items-center gap-2.5">
        <FileAttachment attachment={attachment} key={renderAttachmentKey('file', attachment, 0)} />
      </div>
    );
  }

  const fileCount = localize('com_ui_n_files', { 0: String(count) });
  const buttonLabel = isExpanded
    ? localize('com_ui_hide_n_files', { 0: String(count) })
    : localize('com_ui_show_n_files', { 0: String(count) });

  return (
    <div className="my-2 w-full max-w-full">
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={panelId}
        aria-label={buttonLabel}
        onClick={() => setIsExpanded((prev) => !prev)}
        className="text-text-secondary hover:text-text-primary focus-visible:ring-focus-subtle inline-flex w-full max-w-full items-center gap-2 rounded-lg py-1 pe-2 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
      >
        <FilesIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium">{fileCount}</span>
        {summary.length > 0 && (
          <span className="min-w-0 truncate text-start text-xs font-normal" title={summary}>
            {'· '}
            {summary}
          </span>
        )}
        <ChevronDown
          className={
            isExpanded
              ? 'ms-auto size-4 shrink-0 rotate-180 transition-transform duration-200 ease-out'
              : 'ms-auto size-4 shrink-0 transition-transform duration-200 ease-out'
          }
          aria-hidden="true"
        />
      </button>
      <div id={panelId} className="part-fold" data-open={isExpanded ? 'true' : 'false'}>
        <div className="overflow-hidden" ref={expandRef} aria-hidden={!isExpanded}>
          <div className="flex flex-col gap-2.5 pt-1">
            {groupedAttachments.files.length > 0 && (
              <div className="flex flex-wrap items-center gap-2.5">
                {groupedAttachments.files.map((attachment, index) => (
                  <FileAttachment
                    attachment={attachment}
                    key={renderAttachmentKey('file', attachment, index)}
                  />
                ))}
              </div>
            )}
            {groupedAttachments.textPreviews.map((attachment, index) => (
              <TextAttachment
                attachment={attachment}
                showFileChip={false}
                key={renderAttachmentKey('text', attachment, index)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
FileAttachmentGroup.displayName = 'FileAttachmentGroup';

const TextAttachment = memo(
  ({
    attachment,
    showFileChip = true,
  }: {
    attachment: Partial<TAttachment>;
    showFileChip?: boolean;
  }) => {
    const localize = useLocalize();
    const remScale = useRemScale();
    const collapsedMaxHeight = COLLAPSED_MAX_HEIGHT * remScale;
    const overflowTolerance = OVERFLOW_TOLERANCE * remScale;
    const preId = useId();
    const preRef = useRef<HTMLPreElement>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [overflowed, setOverflowed] = useState(false);
    const file = attachment as TFile & TAttachmentMetadata;
    const handleDownload = useFilesHost().useAttachmentDownload({
      href: attachment.filepath ?? '',
      filename: attachment.filename ?? '',
      fileId: file.file_id,
      user: file.user,
      source: file.source,
    });
    const extension = attachment.filename?.split('.').pop();
    const text = file.text ?? '';
    const visibleFilename = displayFilename(attachment.filename);

    useEffect(() => {
      const timer = setTimeout(() => setIsVisible(true), 50);
      return () => clearTimeout(timer);
    }, []);

    useLayoutEffect(() => {
      const el = preRef.current;
      if (!el) {
        return;
      }
      setOverflowed(el.scrollHeight > collapsedMaxHeight + overflowTolerance);
    }, [text, collapsedMaxHeight, overflowTolerance]);

    const isClamped = overflowed && !expanded;

    return (
      <div
        className={
          isVisible
            ? 'attachment-settle flex w-full translate-y-0 flex-col gap-1.5 subpixel-antialiased opacity-100 transition-all duration-300 ease-out'
            : 'attachment-settle flex w-full translate-y-2 flex-col gap-1.5 subpixel-antialiased opacity-0 transition-all duration-300 ease-out'
        }
      >
        {attachment.filepath && showFileChip && (
          <FileContainer
            file={attachment}
            onClick={handleDownload}
            overrideType={extension}
            displayName={displayFilename(attachment.filename)}
            containerClassName="max-w-fit"
            buttonClassName="bg-surface-secondary hover:cursor-pointer hover:bg-surface-hover active:bg-surface-secondary focus:bg-surface-hover hover:border-border-heavy active:border-border-heavy"
          />
        )}
        <div className="bg-surface-secondary overflow-hidden rounded-lg">
          {!showFileChip && (
            <div className="border-border-inset flex items-center justify-between gap-2 border-b px-3 py-2">
              <span className="min-w-0 truncate text-sm font-medium" title={visibleFilename}>
                {visibleFilename}
              </span>
              {attachment.filepath && (
                <button
                  type="button"
                  onClick={handleDownload}
                  aria-label={`${localize('com_ui_download')} ${visibleFilename}`}
                  title={localize('com_ui_download')}
                  className="text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-focus-subtle flex size-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
                >
                  <Download className="size-4" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          <div className="p-4">
            <pre
              id={preId}
              ref={preRef}
              className={
                isClamped
                  ? 'text-text-primary overflow-hidden font-mono text-sm leading-6 break-words whitespace-pre-wrap'
                  : 'text-text-primary overflow-auto font-mono text-sm leading-6 break-words whitespace-pre-wrap'
              }
              style={isClamped ? { maxHeight: collapsedMaxHeight } : undefined}
            >
              {text}
            </pre>
            {overflowed && (
              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
                aria-controls={preId}
                className="text-text-secondary hover:text-text-primary focus-visible:ring-focus-subtle mt-2 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
              >
                {expanded ? localize('com_ui_collapse') : localize('com_ui_show_all')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  },
);

const ImageAttachment = memo(({ attachment }: { attachment: TAttachment }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const renderImage = useMessagePartsHost().renderImage;
  const { width, height, filepath = null } = attachment as TFile & TAttachmentMetadata;

  useEffect(() => {
    setIsLoaded(false);
    const timer = setTimeout(() => setIsLoaded(true), 100);
    return () => clearTimeout(timer);
  }, [attachment]);

  return (
    <div
      className={
        isLoaded
          ? 'attachment-settle scale-100 subpixel-antialiased opacity-100 transition-all duration-500 ease-out'
          : 'attachment-settle scale-[0.98] subpixel-antialiased opacity-0 transition-all duration-500 ease-out'
      }
    >
      {renderImage({
        altText: attachment.filename ?? '',
        imagePath: filepath ?? '',
        width,
        height,
        className: 'mb-4',
      })}
    </div>
  );
});

function HostArtifact({
  attachment,
  artifact,
}: {
  attachment: TAttachment;
  artifact: AttachmentArtifact;
}) {
  return <>{useFilesHost().renderAttachmentArtifact({ attachment, artifact })}</>;
}

export default function Attachment({ attachment }: { attachment?: TAttachment }): ReactNode {
  const { classifyAttachment } = useFilesHost();
  if (!attachment) {
    return null;
  }
  if (attachment.type === Tools.web_search) {
    return null;
  }
  // Sandbox-internal placeholders (`.dirkeep` etc.) are an implementation
  // detail of the bash executor's empty-folder preservation; users have
  // no reason to see them as their own file chips.
  if (isInternalSandboxArtifact(attachment)) {
    return null;
  }

  if (isImageAttachment(attachment)) {
    return <ImageAttachment attachment={attachment} />;
  }
  const artifact = classifyAttachment(attachment);
  if (artifact != null) {
    return <HostArtifact attachment={attachment} artifact={artifact} />;
  }
  if (isTextAttachment(attachment)) {
    return <TextAttachment attachment={attachment} />;
  }
  if (!attachment.filepath) {
    return null;
  }
  return <FileAttachment attachment={attachment} />;
}

export function AttachmentGroup({ attachments }: { attachments?: TAttachment[] }): ReactNode {
  const { classifyAttachment } = useFilesHost();
  if (!attachments || attachments.length === 0) {
    return null;
  }

  const fileAttachments: TAttachment[] = [];
  const imageAttachments: TAttachment[] = [];
  const textAttachments: TAttachment[] = [];
  /* Pending-preview chips share this row with their future selves.
   * `artifactType` is null while pending so the renderer falls back to
   * FileAttachment (PreviewPlaceholderRow); on resolution it switches
   * to the host's artifact card in place. */
  const panelRow: Array<{ attachment: TAttachment; artifactType: string | null }> = [];
  const mermaidArtifacts: TAttachment[] = [];

  attachments.forEach((attachment) => {
    if (attachment.type === Tools.web_search) {
      return;
    }
    if (isInternalSandboxArtifact(attachment)) {
      return;
    }
    if (isImageAttachment(attachment)) {
      imageAttachments.push(attachment);
      return;
    }
    if ((attachment as Partial<TFile>).status === 'pending') {
      panelRow.push({ attachment, artifactType: null });
      return;
    }
    const artifact = classifyAttachment(attachment);
    if (artifact?.kind === 'mermaid') {
      mermaidArtifacts.push(attachment);
      return;
    }
    if (artifact?.kind === 'panel') {
      panelRow.push({ attachment, artifactType: artifact.artifactType });
      return;
    }
    if (isTextAttachment(attachment)) {
      textAttachments.push(attachment);
      return;
    }
    fileAttachments.push(attachment);
  });

  // Sink empty / placeholder-shaped files in each bucket so the user's
  // eye lands on the real artifact first. `sort` is stable in modern
  // engines (V8 ≥ 7.0) so equal-weight entries keep their input order.
  fileAttachments.sort(bySalience);
  textAttachments.sort(bySalience);
  /* Pending placeholders sort by the same salience as their resolved
   * selves. `attachmentSalience` reads only `bytes`, which resolution
   * does not change, so a row keeps its slot across the loading-to-ready
   * transition instead of jumping once the preview lands. */
  const orderedPanel = [...panelRow].sort(byEntrySalience);
  mermaidArtifacts.sort(bySalience);
  imageAttachments.sort(bySalience);

  const downloadableFileAttachments = fileAttachments.filter((attachment) =>
    Boolean(attachment.filepath),
  );
  const downloadableTextAttachments = textAttachments.filter((attachment) =>
    Boolean(attachment.filepath),
  );
  const textOnlyAttachments = textAttachments.filter((attachment) => !attachment.filepath);
  const groupDownloadableFiles =
    downloadableFileAttachments.length + downloadableTextAttachments.length > 1;
  const groupedFileAttachments = groupDownloadableFiles
    ? [...downloadableFileAttachments, ...downloadableTextAttachments].sort(bySalience)
    : downloadableFileAttachments;
  const visibleTextAttachments = groupDownloadableFiles ? textOnlyAttachments : textAttachments;

  return (
    <>
      {groupedFileAttachments.length > 0 && (
        <FileAttachmentGroup attachments={groupedFileAttachments} />
      )}
      {orderedPanel.length > 0 && (
        <div className="my-2 flex w-full max-w-full flex-col" data-testid="artifact-row-group">
          {orderedPanel.map(({ attachment, artifactType }, index) => {
            if (artifactType != null) {
              return (
                <HostArtifact
                  attachment={attachment}
                  artifact={{ kind: 'panel', artifactType }}
                  key={renderAttachmentKey('artifact', attachment, index)}
                />
              );
            }
            if (!attachment.filepath) {
              return null;
            }
            return (
              <FileAttachment
                attachment={attachment}
                key={renderAttachmentKey('pending', attachment, index)}
              />
            );
          })}
        </div>
      )}
      {mermaidArtifacts.length > 0 && (
        <div className="my-2 flex flex-col gap-3">
          {mermaidArtifacts.map((attachment, index) => (
            <HostArtifact
              attachment={attachment}
              artifact={{ kind: 'mermaid' }}
              key={renderAttachmentKey('mermaid', attachment, index)}
            />
          ))}
        </div>
      )}
      {visibleTextAttachments.length > 0 && (
        <div className="my-2 flex flex-col gap-3">
          {visibleTextAttachments.map((attachment, index) => (
            <TextAttachment
              attachment={attachment}
              key={renderAttachmentKey('text', attachment, index)}
            />
          ))}
        </div>
      )}
      {imageAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center">
          {imageAttachments.map((attachment, index) => (
            <ImageAttachment
              attachment={attachment}
              key={renderAttachmentKey('image', attachment, index)}
            />
          ))}
        </div>
      )}
    </>
  );
}
