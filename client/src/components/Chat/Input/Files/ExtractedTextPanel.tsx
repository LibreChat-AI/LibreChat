import React, { useState } from 'react';
import copy from 'copy-to-clipboard';
import { Spinner } from '@librechat/client';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useFilePreview } from '~/data-provider';
import { useLocalize } from '~/hooks';

interface ExtractedTextPanelProps {
  fileId?: string;
  /** Gates the request so the text is only fetched while it is on screen. */
  enabled: boolean;
  /** Routes the fetch through the share endpoint when the conversation is a shared snapshot. */
  shareId?: string;
}

/**
 * Renders the text a document parser extracted from an upload.
 *
 * Shown verbatim in a monospace block rather than rendered as Markdown: the point
 * is to see exactly what the model receives, structure included.
 */
export default function ExtractedTextPanel({ fileId, enabled, shareId }: ExtractedTextPanelProps) {
  const localize = useLocalize();
  const [isCopied, setIsCopied] = useState(false);
  const { data, isInitialLoading, isError } = useFilePreview(
    fileId,
    {
      enabled: enabled && !!fileId,
      /* Extracted text is immutable once the parse finishes and runs to several MB,
       * so a full refetch on every dialog open is pure waste. Scoped to this panel:
       * the hook's default stays refetch-on-mount for the polling callers. */
      staleTime: Infinity,
    },
    shareId,
  );

  const text = data?.text ?? '';

  const handleCopy = () => {
    copy(text, { format: 'text/plain' });
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  /* `pending` means the parse is still running server-side; the query polls it
   * every 2.5s, so this is a loading state rather than an empty one. */
  if (isInitialLoading || data?.status === 'pending') {
    return (
      <div className="flex h-40 items-center justify-center" role="status">
        <Spinner className="text-text-secondary" />
        <span className="sr-only">{localize('com_ui_loading')}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <p className="py-8 text-center text-sm text-text-secondary" role="alert">
        {localize('com_ui_extracted_text_error')}
      </p>
    );
  }

  if (!text) {
    return (
      <p className="py-8 text-center text-sm text-text-secondary">
        {localize('com_ui_extracted_text_none')}
      </p>
    );
  }

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">
        <CopyButton
          isCopied={isCopied}
          onClick={handleCopy}
          iconOnly
          className="rounded-lg bg-surface-secondary"
        />
      </div>
      {/* Focusable so the overflow region can be scrolled from the keyboard:
       * Chrome and Safari do not focus scroll containers on their own. */}
      <pre
        tabIndex={0}
        role="region"
        aria-label={localize('com_ui_extracted_text_region_label')}
        className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-tertiary p-4 pr-12 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-2"
      >
        {text}
      </pre>
    </div>
  );
}
