import { StackedToolIcons as PackageStackedToolIcons } from '@librechat/chat/components';
import type { StackedToolIconsProps } from '@librechat/chat/components';
import { useMCPServerNames } from '~/hooks/MCP';

/** App adapter: the configured MCP server names come from the app's catalog. */
export default function StackedToolIcons(props: Omit<StackedToolIconsProps, 'mcpServerNames'>) {
  const mcpServerNames = useMCPServerNames();
  return <PackageStackedToolIcons {...props} mcpServerNames={mcpServerNames} />;
}
