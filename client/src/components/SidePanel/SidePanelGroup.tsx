import { useState, memo } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { ResizablePanel, ResizablePanelGroup } from '@librechat/client';
import { ARTIFACTS_SHEET_MAX_WIDTH } from '~/utils/breakpoints';
import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import useDirection from '~/hooks/Nav/useDirection';
import ArtifactsPanel from './ArtifactsPanel';

const PANEL_IDS_SINGLE = ['messages-view'];
/** Keep the persisted id stable so existing artifact panel widths carry over. */
const PANEL_IDS_SPLIT = ['messages-view', 'artifacts-panel'];
const PANEL_IDS_SPLIT_RTL = ['artifacts-panel', 'messages-view'];

interface SidePanelProps {
  panel?: React.ReactNode;
  children: React.ReactNode;
}

const SidePanelGroup = memo(({ panel, children }: SidePanelProps) => {
  const [shouldRenderPanel, setShouldRenderPanel] = useState(panel != null);
  const isSmallScreen = useScaledMaxWidth(ARTIFACTS_SHEET_MAX_WIDTH);
  /**
   * react-resizable-panels reads drag deltas and arrow keys physically (a
   * rightward drag always grows the first panel), so under RTL the group stays
   * LTR and the panels are rendered in reverse: the artifacts panel lands on
   * the inline-end side and every drag still moves the separator with the
   * pointer. Each panel restores the document direction for its content. The
   * library keys the saved layout by panel order, so RTL keeps its own widths.
   */
  const direction = useDirection();
  const reversed = direction === 'rtl';
  const splitIds = reversed ? PANEL_IDS_SPLIT_RTL : PANEL_IDS_SPLIT;

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'side-panel-layout',
    panelIds: panel != null ? splitIds : PANEL_IDS_SINGLE,
    storage: localStorage,
  });

  const minSizeMain = panel != null ? '15' : '30';

  const panels = [
    <ResizablePanel
      key="messages"
      defaultSize="50"
      minSize={minSizeMain}
      id="messages-view"
      dir={direction}
    >
      {children}
    </ResizablePanel>,
    !isSmallScreen && (
      <ArtifactsPanel
        key="artifacts"
        panel={panel}
        minSizeMain={minSizeMain}
        shouldRender={shouldRenderPanel}
        onRenderChange={setShouldRenderPanel}
        reversed={reversed}
      />
    ),
  ];

  return (
    <>
      {/* The surface behind the panels is this group's host, not the group
          primitive: the resizer owns its own chrome, and the caller owns the
          backdrop the panels sit on. */}
      <div className="relative min-w-0 flex-1">
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          dir="ltr"
        >
          {reversed ? panels.reverse() : panels}
        </ResizablePanelGroup>
      </div>
      {panel != null && isSmallScreen && <div className="fixed inset-0 z-[100]">{panel}</div>}
    </>
  );
});

SidePanelGroup.displayName = 'SidePanelGroup';

export default SidePanelGroup;
