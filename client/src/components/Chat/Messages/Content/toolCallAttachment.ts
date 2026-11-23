import type { TAttachment } from 'librechat-data-provider';
import type { ReactNode } from 'react';

/** Draws the attachments under a tool call. The parts host reads this; the content stack registers it. */
export type ToolCallAttachmentRenderer = (attachments: TAttachment[]) => ReactNode;

let renderToolCallAttachments: ToolCallAttachmentRenderer = () => null;

export function setToolCallAttachments(render: ToolCallAttachmentRenderer): void {
  renderToolCallAttachments = render;
}

export function getToolCallAttachments(): ToolCallAttachmentRenderer {
  return renderToolCallAttachments;
}
