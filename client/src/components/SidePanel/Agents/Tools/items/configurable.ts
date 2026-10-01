import type { AgentItem } from './types';
import { pluginNeedsAuth } from './auth';

/**
 * Whether an item's detail dialog exposes configurable controls (credentials,
 * tool selection, server/action settings) beyond a plain description. Drives the
 * Settings-vs-Info affordance: a configurable item gets a cog button, an
 * informational one gets an info icon.
 */
export function hasConfigurableSettings(item: AgentItem): boolean {
  switch (item.kind) {
    case 'builtin':
      return (
        item.id === 'artifacts' ||
        item.id === 'execute_code' ||
        item.id === 'file_search' ||
        item.id === 'context' ||
        item.id === 'memory' ||
        (item.id === 'web_search' && item.userProvidedAuth === true)
      );
    case 'tool':
      return pluginNeedsAuth(item.plugin);
    case 'mcp':
    case 'action':
      return true;
    case 'skill':
      return false;
    default:
      return false;
  }
}
