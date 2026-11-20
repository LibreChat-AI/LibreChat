import { useEffect, memo } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { ResizableHandleAlt, ResizablePanel } from '@librechat/client';
import useDirection from '~/hooks/Nav/useDirection';

interface ArtifactsPanelProps {
  panel: React.ReactNode | null;
  minSizeMain: string;
  shouldRender: boolean;
  onRenderChange: (shouldRender: boolean) => void;
  /** Rendered before the messages panel (RTL), so the handle follows the panel. */
  reversed?: boolean;
}

const ArtifactsPanel = memo(function ArtifactsPanel({
  panel,
  minSizeMain,
  shouldRender,
  onRenderChange,
  reversed = false,
}: ArtifactsPanelProps) {
  const artifactsPanelRef = usePanelRef();
  const direction = useDirection();

  useEffect(() => {
    if (panel != null) {
      onRenderChange(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          artifactsPanelRef.current?.expand();
        });
      });
    } else if (shouldRender) {
      onRenderChange(false);
    }
  }, [panel, shouldRender, onRenderChange, artifactsPanelRef]);

  if (!shouldRender) {
    return null;
  }

  const handle = panel != null && <ResizableHandleAlt withHandle className="text-text-primary" />;

  return (
    <>
      {!reversed && handle}
      <ResizablePanel
        defaultSize="50"
        maxSize="70"
        collapsedSize="0"
        collapsible={true}
        minSize={minSizeMain}
        panelRef={artifactsPanelRef}
        id="artifacts-panel"
        dir={direction}
      >
        <div className="h-full min-w-[min(25rem,100%)] overflow-hidden">{panel}</div>
      </ResizablePanel>
      {reversed && handle}
    </>
  );
});

ArtifactsPanel.displayName = 'ArtifactsPanel';

export default ArtifactsPanel;
