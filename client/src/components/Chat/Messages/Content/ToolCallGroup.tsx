import { ToolCallGroup as PackageToolCallGroup } from '@librechat/chat/components';
import type { ToolCallGroupProps } from '@librechat/chat/components';
import type { TAttachment } from 'librechat-data-provider';
import { MCPAppViews } from '~/components/MCPUIResource';
/** Registers the app's host, which the group reads its settings and MCP catalog from. */
import '~/Providers/MessagePartsHostContext';

export type { ToolCallGroupExpansionState } from '@librechat/chat/components';

const renderAppViews = (attachments: TAttachment[]) => <MCPAppViews attachments={attachments} />;

/** App adapter: the embedded MCP app views under a group's files are the app's. */
export default function ToolCallGroup(props: Omit<ToolCallGroupProps, 'renderAppViews'>) {
  return <PackageToolCallGroup {...props} renderAppViews={renderAppViews} />;
}
