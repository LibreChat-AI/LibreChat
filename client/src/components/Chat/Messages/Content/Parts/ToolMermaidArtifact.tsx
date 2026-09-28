import { memo, useId, useLayoutEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useRecoilState } from 'recoil';
import type { TAttachment, TFile, TAttachmentMetadata } from 'librechat-data-provider';
import { fileToArtifact, TOOL_ARTIFACT_TYPES, toolArtifactKey } from '~/utils/artifacts';
import Mermaid from '~/components/Messages/Content/Mermaid/Mermaid';
import { displayFilename } from './attachmentTypes';
import { useAttachmentLink } from './LogLink';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

interface ToolMermaidArtifactProps {
  attachment: TAttachment;
  text: string;
}

/**
 * Renders a code-execution-produced Mermaid artifact inline until the
 * user opens it in the Artifact panel. The compact card keeps the file
 * available in chat without rendering the same diagram twice.
 *
 * Shares the `toolArtifactClaim` dedup atom with `ToolArtifactCard` so
 * the same `.mmd` file can't double-render across tool calls / messages.
 */
const ToolMermaidArtifact = memo(({ attachment, text }: ToolMermaidArtifactProps) => {
  const localize = useLocalize();
  const file = attachment as TFile & TAttachmentMetadata;
  const claimKey = useId();
  const [claim, setClaim] = useRecoilState(store.toolArtifactClaim(toolArtifactKey(file)));
  const isMyClaim = claim === claimKey;
  /* Once the diagram collapses into its trigger row, that row carries the
   * filename and the download itself, so this header would repeat both
   * beside it. */
  const [isRowMode, setIsRowMode] = useState(false);

  useLayoutEffect(() => {
    setClaim(claimKey);
    return () => {
      setClaim((prev) => (prev === claimKey ? null : prev));
    };
  }, [claimKey, setClaim]);

  const { handleDownload } = useAttachmentLink({
    href: attachment.filepath ?? '',
    filename: attachment.filename ?? '',
    file_id: file.file_id,
    user: file.user,
    source: file.source,
  });
  const artifact = useMemo(
    () =>
      fileToArtifact({ ...attachment, text }, { preClassifiedType: TOOL_ARTIFACT_TYPES.MERMAID }),
    [attachment, text],
  );

  if (claim != null && !isMyClaim) {
    return null;
  }

  const visibleFilename = displayFilename(attachment.filename);

  return (
    <div className="my-2 flex w-full flex-col gap-1">
      {!isRowMode && (attachment.filename || attachment.filepath) && (
        <div className="flex items-center justify-between gap-2">
          {attachment.filename && (
            <div
              className="truncate text-[10px] font-medium uppercase tracking-wide text-text-secondary"
              title={visibleFilename}
            >
              {visibleFilename}
            </div>
          )}
          {attachment.filepath && (
            <button
              type="button"
              onClick={handleDownload}
              aria-label={`${localize('com_ui_download')} ${visibleFilename}`}
              title={localize('com_ui_download')}
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs',
                'text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy',
              )}
            >
              <Download className="size-3" aria-hidden="true" />
              {localize('com_ui_download')}
            </button>
          )}
        </div>
      )}
      {/* `id` is optional on Mermaid; pass only when we have a real file_id
          so the component generates a unique render target on its own. */}
      {file.file_id ? (
        <Mermaid
          id={file.file_id}
          artifact={artifact ?? undefined}
          onDownload={attachment.filepath ? handleDownload : undefined}
          onRowModeChange={setIsRowMode}
          rowTitle={attachment.filename ? visibleFilename : undefined}
        >
          {text}
        </Mermaid>
      ) : (
        <Mermaid
          artifact={artifact ?? undefined}
          onDownload={attachment.filepath ? handleDownload : undefined}
          onRowModeChange={setIsRowMode}
          rowTitle={attachment.filename ? visibleFilename : undefined}
        >
          {text}
        </Mermaid>
      )}
    </div>
  );
});

ToolMermaidArtifact.displayName = 'ToolMermaidArtifact';

export default ToolMermaidArtifact;
