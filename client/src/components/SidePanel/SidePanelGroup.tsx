import { useState, memo } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { ResizablePanel, ResizablePanelGroup, useMediaQuery } from '@librechat/client';
import ArtifactsPanel from './ArtifactsPanel';

const PANEL_IDS_SINGLE = ['messages-view'];
/** Keep the persisted id stable so existing artifact panel widths carry over. */
const PANEL_IDS_SPLIT = ['messages-view', 'artifacts-panel'];

interface SidePanelProps {
  panel?: React.ReactNode;
  children: React.ReactNode;
}

const SidePanelGroup = memo(({ panel, children }: SidePanelProps) => {
  const [shouldRenderPanel, setShouldRenderPanel] = useState(panel != null);
  const isSmallScreen = useMediaQuery('(max-width: 767px)');

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'side-panel-layout',
    panelIds: panel != null ? PANEL_IDS_SPLIT : PANEL_IDS_SINGLE,
    storage: localStorage,
  });

  const minSizeMain = panel != null ? '15' : '30';

  return (
    <>
      {/* The surface behind the panels is this group's host, not the group
          primitive: the resizer owns its own chrome, and the caller owns the
          backdrop the panels sit on. */}
      <div className="bg-surface-primary-alt relative min-w-0 flex-1">
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <ResizablePanel defaultSize="50" minSize={minSizeMain} id="messages-view">
            {children}
          </ResizablePanel>

          {!isSmallScreen && (
            <ArtifactsPanel
              panel={panel}
              minSizeMain={minSizeMain}
              shouldRender={shouldRenderPanel}
              onRenderChange={setShouldRenderPanel}
            />
          )}
        </ResizablePanelGroup>
      </div>
      {panel != null && isSmallScreen && <div className="fixed inset-0 z-[100]">{panel}</div>}
    </>
  );
});

SidePanelGroup.displayName = 'SidePanelGroup';

export default SidePanelGroup;
