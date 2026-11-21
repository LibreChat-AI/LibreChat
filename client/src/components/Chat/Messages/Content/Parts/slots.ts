import type { ContentPartsSlotProps } from '@librechat/chat/react';
import type { ReactNode } from 'react';
import type { MessagePartsHost } from '~/hooks/Chat/contract';

/** The host slots drawn with app components that import the markdown stack. */
export type AppPartRenderers = Pick<
  MessagePartsHost,
  'renderMarkdown' | 'renderAgentIcon' | 'renderImage' | 'renderFilePreview'
>;

let appPartRenderers: AppPartRenderers | null = null;

/**
 * Registers the app's slot renderers. The parts barrel registers them when it loads, so the app's
 * message parts host reads them without importing the markdown stack itself.
 */
export function setAppPartRenderers(renderers: AppPartRenderers): void {
  appPartRenderers = renderers;
}

export function getAppPartRenderers(): AppPartRenderers {
  if (appPartRenderers == null) {
    throw new Error(
      'Message part renderers are registered by ~/components/Chat/Messages/Content/Parts.',
    );
  }
  return appPartRenderers;
}

let appContentParts: ((props: ContentPartsSlotProps) => ReactNode) | null = null;

/** Registers the app's content-parts renderer, which `~/components/Chat/Messages/Content/register`
 *  does when the app entry loads it, so the host never imports the content stack itself. */
export function setAppContentParts(render: (props: ContentPartsSlotProps) => ReactNode): void {
  appContentParts = render;
}

export function getAppContentParts(): (props: ContentPartsSlotProps) => ReactNode {
  if (appContentParts == null) {
    throw new Error(
      'The content-parts renderer is registered by ~/components/Chat/Messages/Content/register.',
    );
  }
  return appContentParts;
}

/** The host slots a reply's markdown elements fill with app components: the code block that can
 *  run, and the mermaid diagram. */
export type AppMarkdownSlots = Required<
  Pick<MessagePartsHost, 'renderCodeBlock' | 'renderMermaid'>
>;

let appMarkdownSlots: AppMarkdownSlots | null = null;

/** Registers the app's markdown slots. `../MarkdownComponents` does when it loads, and every app
 *  surface takes its markdown elements from that module, so the host never imports the code
 *  block, the run button or the diagram itself. */
export function setAppMarkdownSlots(slots: AppMarkdownSlots): void {
  appMarkdownSlots = slots;
}

/** Null until a surface that draws markdown has loaded. */
export function getAppMarkdownSlots(): AppMarkdownSlots | null {
  return appMarkdownSlots;
}
