import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Button, Spinner } from '@librechat/client';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import type { ProcessedMermaidSvg } from '~/utils/diagram/export';
import ArtifactRow from '~/components/Chat/Messages/Content/Parts/ArtifactRow';
import { MERMAID_ARTIFACT_TYPE, type Artifact } from '~/common/artifacts';
import { artifactRowKind } from '~/utils/artifacts';
import useSvgProcessing from './useSvgProcessing';
import { useMessageContext } from '~/Providers';
import useMermaidZoom from './useMermaidZoom';
import MermaidDialog from './MermaidDialog';
import MermaidHeader from './MermaidHeader';
import ZoomControls from './ZoomControls';
import { isArtifactRoute } from '~/utils';
import { useLocalize } from '~/hooks';
import cn from '~/utils/cn';
import store from '~/store';

interface MermaidProps {
  children: string;
  id?: string;
  theme?: string;
  artifact?: Artifact;
  /**
   * Saves the file a code-execution diagram came from. Once the diagram
   * collapses into its trigger row, the row owns this action the way every
   * other file-backed artifact row does, so the caller's own header can
   * step aside instead of repeating the filename beside it.
   */
  onDownload?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Reports whether the diagram is currently rendered as its trigger row. */
  onRowModeChange?: (isRow: boolean) => void;
  /**
   * Name to show on the trigger row, when the caller holds a friendlier one
   * than the artifact's raw title — a sandbox-generated `_.flow-abcdef.mmd`
   * reads as `.flow.mmd` through `displayFilename`, and the row (plus its
   * download button's accessible name) must not regress to the internal
   * filename the way it would by falling back to `artifact.title`.
   */
  rowTitle?: string;
}

interface MermaidRendererProps
  extends Omit<MermaidProps, 'artifact' | 'onDownload' | 'onRowModeChange' | 'rowTitle'> {
  fillContainer?: boolean;
  onExpand?: () => void;
  onExportReady?: (data: ProcessedMermaidSvg | null) => void;
  exportFilename: string;
  showExpandButton?: boolean;
  showHeader?: boolean;
}

const Mermaid: React.FC<MermaidProps> = memo((props) => {
  const {
    children,
    id,
    theme,
    artifact: artifactProp,
    onDownload,
    onRowModeChange,
    rowTitle,
  } = props;
  const localize = useLocalize();
  const location = useLocation();
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const { messageId, partIndex } = useMessageContext();
  const artifactButtonRef = useRef<HTMLButtonElement>(null);
  const shouldFocusArtifactCardRef = useRef(false);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const setArtifacts = useSetRecoilState(store.artifactsState);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const defaultTitle = localize('com_ui_mermaid_diagram');
  const canOpenArtifact = isArtifactRoute(location.pathname);
  /* Each content part renders its own markdown tree, so the per-message
   * Mermaid counter restarts at zero in every part: diagrams sitting either
   * side of a tool call would otherwise share an id within one message. */
  const artifactScope = messageId ? `${messageId}-part${partIndex ?? 0}` : instanceId;
  const artifactId = `mermaid-artifact-${artifactScope}-${id || instanceId}`;
  const artifact = useMemo<Artifact>(() => {
    if (artifactProp != null) {
      return {
        ...artifactProp,
        type: artifactProp.type ?? MERMAID_ARTIFACT_TYPE,
        title: artifactProp.title ?? defaultTitle,
        content: children,
        messageId: artifactProp.messageId ?? messageId,
      };
    }

    return {
      id: artifactId,
      identifier: artifactId,
      type: MERMAID_ARTIFACT_TYPE,
      title: defaultTitle,
      content: children,
      messageId,
      lastUpdateTime: Date.now(),
    };
  }, [artifactId, artifactProp, children, defaultTitle, messageId]);
  const isSelected = currentArtifactId === artifact.id;
  const [isArtifactCard, setIsArtifactCard] = useState(() => canOpenArtifact && isSelected);

  const registerArtifact = useCallback(() => {
    setArtifacts((previousArtifacts) => {
      const existingArtifact = previousArtifacts?.[artifact.id];
      if (
        existingArtifact != null &&
        existingArtifact.content === artifact.content &&
        existingArtifact.type === artifact.type &&
        existingArtifact.title === artifact.title
      ) {
        return previousArtifacts;
      }

      return { ...(previousArtifacts ?? {}), [artifact.id]: artifact };
    });
  }, [artifact, setArtifacts]);

  const openArtifact = useCallback(() => {
    registerArtifact();
    setCurrentArtifactId(artifact.id);
    setArtifactsVisible(true);
  }, [artifact.id, registerArtifact, setArtifactsVisible, setCurrentArtifactId]);

  const handleExpand = useCallback(() => {
    shouldFocusArtifactCardRef.current = true;
    setIsArtifactCard(true);
    openArtifact();
  }, [openArtifact]);

  const handleArtifactClick = useCallback(() => {
    if (!isSelected) {
      openArtifact();
      return;
    }

    setCurrentArtifactId(null);
    setArtifactsVisible(false);
  }, [isSelected, openArtifact, setArtifactsVisible, setCurrentArtifactId]);

  /* Closing the panel unmounts `Artifacts`, whose `useArtifacts` cleanup wipes
   * `artifactsState`. Subscribing to this diagram's slice re-fires the
   * registration once it goes missing, so reopening any card restores every
   * expanded diagram to the version navigator rather than just the one
   * clicked. `registerArtifact` no-ops when the entry already matches, so this
   * cannot loop. Mirrors the self-heal in `ToolArtifactCard`. */
  const existingEntry = useRecoilValue(store.artifactByIdSelector(artifact.id));

  useEffect(() => {
    if (!isArtifactCard) {
      return;
    }
    registerArtifact();
  }, [existingEntry, isArtifactCard, registerArtifact]);

  useEffect(() => {
    if (!isArtifactCard || !shouldFocusArtifactCardRef.current) {
      return;
    }
    artifactButtonRef.current?.focus();
    shouldFocusArtifactCardRef.current = false;
  }, [isArtifactCard]);

  const isRowMode = canOpenArtifact && isArtifactCard;
  useEffect(() => {
    onRowModeChange?.(isRowMode);
  }, [isRowMode, onRowModeChange]);

  if (isRowMode) {
    return (
      <ArtifactRow
        ref={artifactButtonRef}
        artifactId={artifact.id}
        title={rowTitle ?? artifact.title ?? defaultTitle}
        kind={artifactRowKind(artifact)}
        isSelected={isSelected}
        onOpen={handleArtifactClick}
        onDownload={onDownload}
      />
    );
  }

  return (
    <MermaidRenderer
      id={id}
      theme={theme}
      exportFilename={artifact.title ?? defaultTitle}
      onExpand={canOpenArtifact ? handleExpand : undefined}
    >
      {children}
    </MermaidRenderer>
  );
});

export const MermaidRenderer = memo(function MermaidRenderer({
  children,
  id,
  theme,
  onExpand,
  onExportReady,
  exportFilename,
  fillContainer = false,
  showExpandButton = true,
  showHeader = true,
}: MermaidRendererProps) {
  const localize = useLocalize();
  const [showCode, setShowCode] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [showMobileControls, setShowMobileControls] = useState(false);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const streamingCodeRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setIsTouchDevice('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);

  const {
    blobUrl,
    processedSvg,
    svgDimensions,
    isLoading,
    error,
    lastValidSvgRef,
    initialScale,
    calculatedHeight,
  } = useSvgProcessing({ content: children, id, theme, retryCount, containerRef });

  const exportReadyRef = useRef(onExportReady);

  useEffect(() => {
    exportReadyRef.current = onExportReady;
    onExportReady?.(processedSvg == null ? null : { svg: processedSvg, dimensions: svgDimensions });
  }, [onExportReady, processedSvg, svgDimensions]);

  /* The preview tab unmounts when the panel switches to the code view, which
   * would otherwise leave the toolbar exporting a payload no longer on screen
   * and no longer matching an edited source. */
  useEffect(() => () => exportReadyRef.current?.(null), []);

  const { zoom, pan, isPanning, handleZoomIn, handleZoomOut, handleResetZoom, handleMouseDown } =
    useMermaidZoom({ containerRef, wheelDep: blobUrl });

  useEffect(() => {
    if (isLoading && streamingCodeRef.current) {
      streamingCodeRef.current.scrollTop = streamingCodeRef.current.scrollHeight;
    }
  }, [children, isLoading]);

  const handleToggleCode = useCallback(() => setShowCode((prev) => !prev), []);
  const handleRetry = useCallback(() => setRetryCount((prev) => prev + 1), []);
  const handleExpand = useCallback(() => {
    if (onExpand != null) {
      onExpand();
      return;
    }
    setIsDialogOpen(true);
  }, [onExpand]);

  const handleContainerClick = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!isTouchDevice) {
        return;
      }
      const target = e.target as HTMLElement;
      if (!target.closest('button, a, [role="button"]')) {
        setShowMobileControls((prev) => !prev);
      }
    },
    [isTouchDevice],
  );

  const showControls = isTouchDevice
    ? showMobileControls || showCode
    : isHovered || isFocusWithin || showCode;

  const hoverHandlers = {
    onMouseEnter: () => setIsHovered(true),
    onMouseLeave: () => setIsHovered(false),
    onFocus: () => setIsFocusWithin(true),
    onBlur: (e: React.FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setIsFocusWithin(false);
      }
    },
  };

  const diagramStyle = {
    width: svgDimensions ? `${svgDimensions.width * initialScale}px` : 'auto',
    height: svgDimensions ? `${svgDimensions.height * initialScale}px` : 'auto',
  };

  if (isLoading) {
    if (lastValidSvgRef.current && blobUrl) {
      return (
        <>
          {showExpandButton && onExpand == null && (
            <MermaidDialog
              open={isDialogOpen}
              onOpenChange={setIsDialogOpen}
              triggerRef={expandButtonRef}
              blobUrl={blobUrl}
              codeContent={children}
              exportSvg={processedSvg}
              exportDimensions={svgDimensions}
              exportFilename={exportFilename}
            />
          )}
          <div
            className={cn(
              'relative w-full overflow-hidden rounded-lg border transition-all duration-200',
              fillContainer && 'h-full rounded-xl',
              showControls ? 'border-border-light' : 'border-transparent',
            )}
            {...hoverHandlers}
            onClick={handleContainerClick}
          >
            {showHeader && (
              <MermaidHeader
                className={cn(
                  showCode
                    ? 'relative z-20 border-b border-border-light bg-surface-secondary'
                    : 'absolute left-0 right-0 top-0 z-20',
                  showControls ? 'opacity-100' : 'pointer-events-none opacity-0',
                )}
                codeContent={children}
                showCode={showCode}
                showExpandButton={showExpandButton}
                expandButtonRef={expandButtonRef}
                expandLabel={onExpand != null ? localize('com_ui_open_as_artifact') : undefined}
                exportSvg={processedSvg}
                exportDimensions={svgDimensions}
                exportFilename={exportFilename}
                onExpand={handleExpand}
                onToggleCode={handleToggleCode}
              />
            )}
            {showCode && (
              <div className="min-h-[150px] bg-surface-primary-alt p-4">
                <pre className="overflow-auto whitespace-pre-wrap font-mono text-xs text-text-secondary">
                  {children}
                </pre>
              </div>
            )}
            <div
              ref={containerRef}
              hidden={showCode}
              className={cn(
                'relative overflow-hidden rounded-md p-4 transition-colors duration-200',
                fillContainer && 'h-full rounded-lg',
                'bg-surface-primary-alt',
                isPanning ? 'cursor-grabbing' : 'cursor-grab',
              )}
              style={fillContainer ? undefined : { height: `${calculatedHeight}px` }}
              data-testid={fillContainer ? 'mermaid-artifact-canvas' : undefined}
              onMouseDown={handleMouseDown}
            >
              <div className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded border border-border-light bg-surface-secondary px-2 py-1 text-xs text-text-secondary">
                <Spinner className="h-3 w-3" />
              </div>
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transition: isPanning ? 'none' : 'transform 0.1s ease-out',
                }}
              >
                <img
                  src={blobUrl}
                  alt={localize('com_ui_mermaid_diagram')}
                  className="select-none opacity-70"
                  style={diagramStyle}
                  draggable={false}
                />
              </div>
              <ZoomControls
                zoom={zoom}
                pan={pan}
                codeContent={children}
                onZoomIn={handleZoomIn}
                onZoomOut={handleZoomOut}
                onReset={handleResetZoom}
                className={cn(
                  'absolute bottom-2 right-2 z-10 transition-opacity duration-200',
                  showControls ? 'opacity-100' : 'pointer-events-none opacity-0',
                )}
              />
            </div>
          </div>
        </>
      );
    }

    if (!showHeader) {
      return (
        <div
          className={cn(
            'flex min-h-[200px] w-full items-center justify-center rounded-lg border border-border-light bg-surface-primary-alt text-text-secondary',
            fillContainer && 'h-full rounded-xl',
          )}
          role="status"
        >
          <Spinner className="size-5" aria-hidden="true" />
          <span className="sr-only">{localize('com_ui_loading')}</span>
        </div>
      );
    }

    return (
      <div
        className={cn(
          'w-full overflow-hidden rounded-lg border border-border-light',
          fillContainer && 'h-full rounded-xl',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border-light bg-surface-secondary px-4 py-2 font-sans text-xs text-text-secondary">
          <Spinner className="h-3 w-3" />
          <span className="font-medium">{localize('com_ui_mermaid')}</span>
        </div>
        <pre
          ref={streamingCodeRef}
          className="max-h-[350px] min-h-[150px] overflow-auto whitespace-pre-wrap bg-surface-primary-alt p-4 font-mono text-xs text-text-secondary"
        >
          {children}
        </pre>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full overflow-hidden rounded-lg border border-border-light">
        {showHeader && (
          <MermaidHeader
            codeContent={children}
            showCode={showCode}
            onToggleCode={handleToggleCode}
          />
        )}
        {showCode ? (
          <div className="border-t border-border-light bg-surface-primary-alt p-4">
            <pre className="overflow-auto whitespace-pre-wrap text-xs text-text-secondary">
              {children}
            </pre>
          </div>
        ) : (
          <div className="border-t border-border-light bg-surface-tertiary p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-text-destructive">
                {localize('com_ui_mermaid_failed')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRetry}
                className="h-auto gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {localize('com_ui_retry')}
              </Button>
            </div>
            <pre className="overflow-auto text-xs text-text-destructive">{error.message}</pre>
          </div>
        )}
      </div>
    );
  }

  if (!blobUrl) {
    return null;
  }

  return (
    <>
      {showExpandButton && onExpand == null && (
        <MermaidDialog
          open={isDialogOpen}
          onOpenChange={setIsDialogOpen}
          triggerRef={expandButtonRef}
          blobUrl={blobUrl}
          codeContent={children}
          exportSvg={processedSvg}
          exportDimensions={svgDimensions}
          exportFilename={exportFilename}
        />
      )}
      <div
        className={cn(
          'relative w-full overflow-hidden rounded-lg border border-border-light transition-all duration-200',
          fillContainer && 'h-full rounded-xl',
        )}
        {...hoverHandlers}
        onClick={handleContainerClick}
      >
        {showHeader && (
          <MermaidHeader
            className="border-b border-border-light bg-surface-secondary"
            actionsClassName="transition-opacity duration-200"
            codeContent={children}
            showCode={showCode}
            showExpandButton={showExpandButton}
            expandButtonRef={expandButtonRef}
            expandLabel={onExpand != null ? localize('com_ui_open_as_artifact') : undefined}
            exportSvg={processedSvg}
            exportDimensions={svgDimensions}
            exportFilename={exportFilename}
            onExpand={handleExpand}
            onToggleCode={handleToggleCode}
          />
        )}
        {showCode && (
          <div className="bg-surface-primary-alt p-4">
            <pre className="overflow-auto whitespace-pre-wrap text-xs text-text-secondary">
              {children}
            </pre>
          </div>
        )}
        <div
          ref={containerRef}
          hidden={showCode}
          className={cn(
            'relative overflow-hidden p-4 transition-colors duration-200',
            fillContainer && 'h-full rounded-lg',
            'bg-surface-primary-alt',
            isPanning ? 'cursor-grabbing' : 'cursor-grab',
          )}
          style={fillContainer ? undefined : { height: `${calculatedHeight}px` }}
          data-testid={fillContainer ? 'mermaid-artifact-canvas' : undefined}
          onMouseDown={handleMouseDown}
        >
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transition: isPanning ? 'none' : 'transform 0.1s ease-out',
            }}
          >
            <img
              src={blobUrl}
              alt={localize('com_ui_mermaid_diagram')}
              className="select-none"
              style={diagramStyle}
              draggable={false}
            />
          </div>
          <ZoomControls
            zoom={zoom}
            pan={pan}
            codeContent={children}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onReset={handleResetZoom}
            className={cn(
              'absolute bottom-2 right-2 z-10 transition-opacity duration-200',
              showControls ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          />
        </div>
      </div>
    </>
  );
});

Mermaid.displayName = 'Mermaid';
MermaidRenderer.displayName = 'MermaidRenderer';

export default Mermaid;
