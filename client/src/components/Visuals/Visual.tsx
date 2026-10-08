import { memo, useMemo, useState, useEffect, useCallback } from 'react';
import filenamify from 'filenamify';
import { Download, PanelRight } from 'lucide';
import { useLocation } from 'react-router-dom';
import { Button, MorphIcon, Spinner, TooltipAnchor } from '@librechat/client';
import type { Artifact } from '~/common';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { VISUAL_ARTIFACT_TYPE } from '~/common/artifacts';
import { useLocalize, useCopyToClipboard } from '~/hooks';
import VisualFrame, { VISUAL_MAX_HEIGHT } from './Frame';
import { triggerDownload } from '~/utils/downloadFile';
import { isArtifactRoute } from '~/utils';
import { hashText } from './hash';

interface VisualProps {
  title?: string;
  html?: string;
  /** `'true'` once the container's closing fence has streamed in. */
  complete?: string;
}

/** Inline visuals stop here until the reader asks for the rest. */
const VISUAL_INLINE_HEIGHT = 640;

/** A title as a download name, sanitized the way artifact downloads are. */
export function visualFileName(title: string): string {
  return filenamify(`${title.trim() || 'visual'}.html`, { replacement: '_' });
}

/**
 * An inline visual in a reply: its title, actions, and the sandboxed page. While the container
 * is still streaming it holds a placeholder; a reply that ended without the closing fence still
 * renders what arrived.
 */
const Visual = memo(function Visual({ title, html = '', complete }: VisualProps) {
  const localize = useLocalize();
  const location = useLocation();
  const { useMessage, useArtifactPanel, useVisualsAllowed } = useMessagePartsHost();
  const allowed = useVisualsAllowed();
  const { messageId, isSubmitting, isLatestMessage } = useMessage();
  const label = title?.trim() || localize('com_ui_visual');
  const streaming = isSubmitting === true && isLatestMessage === true;
  const ready = complete === 'true' || !streaming;

  /* Hashed only once the page is whole: a streaming page changes on every token. */
  const artifactId = useMemo(
    () => (ready ? `visual-${messageId ?? 'local'}-${hashText(html)}` : ''),
    [html, messageId, ready],
  );
  const { currentArtifactId, registered, register, open, close } = useArtifactPanel(artifactId);
  const canOpenPanel = ready && allowed === true && isArtifactRoute(location.pathname);
  const isOpenInPanel = currentArtifactId === artifactId;

  const artifact = useMemo<Artifact>(
    () => ({
      id: artifactId,
      identifier: artifactId,
      type: VISUAL_ARTIFACT_TYPE,
      title: label,
      content: html,
      messageId,
      lastUpdateTime: Date.now(),
    }),
    [artifactId, html, label, messageId],
  );

  /* The panel's registry is wiped when it unmounts; once opened, this visual re-registers
   * itself, as the Mermaid and tool artifact cards do. */
  const [wasOpened, setWasOpened] = useState(false);
  useEffect(() => {
    if (!wasOpened || (registered != null && registered.content === artifact.content)) {
      return;
    }
    register(artifact);
  }, [artifact, register, registered, wasOpened]);

  const onTogglePanel = useCallback(() => {
    if (isOpenInPanel) {
      close();
      return;
    }
    register(artifact);
    setWasOpened(true);
    open(artifact.id);
  }, [artifact, close, isOpenInPanel, open, register]);

  const [contentHeight, setContentHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const isTall = contentHeight > VISUAL_INLINE_HEIGHT;

  const [isCopied, setIsCopied] = useState(false);
  const copyHtml = useCopyToClipboard({ text: html });
  const onCopy = useCallback(() => copyHtml(setIsCopied), [copyHtml]);

  const onDownload = useCallback(() => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    triggerDownload(url, visualFileName(label));
  }, [html, label]);

  const panelLabel = isOpenInPanel
    ? localize('com_ui_close_panel')
    : localize('com_ui_open_in_panel');

  return (
    <figure className="my-3 w-full">
      <div className="flex min-h-8 items-center gap-2">
        <figcaption className="text-text-secondary min-w-0 flex-1 truncate text-sm font-medium">
          {label}
        </figcaption>
        {ready && (
          <div className="flex shrink-0 items-center gap-1">
            {canOpenPanel && (
              <TooltipAnchor
                description={panelLabel}
                render={
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label={panelLabel}
                    onClick={onTogglePanel}
                  >
                    <MorphIcon icon={PanelRight} size="1rem" />
                  </Button>
                }
              />
            )}
            <TooltipAnchor
              description={localize('com_ui_download')}
              render={
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={localize('com_ui_download')}
                  onClick={onDownload}
                >
                  <MorphIcon icon={Download} size="1rem" />
                </Button>
              }
            />
            <CopyButton
              isCopied={isCopied}
              iconOnly
              onClick={onCopy}
              label={localize('com_ui_copy_code')}
            />
          </div>
        )}
      </div>
      {allowed === false && ready && (
        <p className="text-text-secondary text-sm">{localize('com_ui_visuals_disabled')}</p>
      )}
      {allowed === true && ready && (
        <>
          <div className="relative">
            <VisualFrame
              html={html}
              title={label}
              maxHeight={expanded ? VISUAL_MAX_HEIGHT : VISUAL_INLINE_HEIGHT}
              onContentHeight={setContentHeight}
            />
            {isTall && !expanded && (
              <div
                aria-hidden="true"
                data-testid="visual-fade"
                className="from-surface-canvas pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent"
              />
            )}
          </div>
          {isTall && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {localize(expanded ? 'com_ui_show_less' : 'com_ui_show_more')}
            </Button>
          )}
        </>
      )}
      {(!ready || allowed === undefined) && (
        <div
          className="border-border-light bg-surface-secondary text-text-secondary flex h-40 items-center justify-center gap-2 rounded-lg border text-sm"
          role="status"
        >
          <Spinner className="size-4" aria-hidden="true" />
          {localize('com_ui_visual_building')}
        </div>
      )}
    </figure>
  );
});

export default Visual;
