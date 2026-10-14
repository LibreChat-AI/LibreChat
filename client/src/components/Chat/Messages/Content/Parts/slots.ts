import type { MessagePartsHost } from '~/hooks/Chat/contract';

/** The host slots drawn with app components that import the markdown stack. */
export type AppPartRenderers = Pick<MessagePartsHost, 'renderMarkdown' | 'renderAgentIcon'>;

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
