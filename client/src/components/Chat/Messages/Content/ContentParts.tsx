import { ContentParts as ChatContentParts } from '@librechat/chat/components';
import type { ContentPartsProps, ContentPartsSlots } from '@librechat/chat/components';
import { useSubagentAttachmentCallsQueries } from '~/data-provider';
import { useMCPAppsPolicy } from '~/Providers/MCPAppsPolicyContext';
import { MCPAppViews } from '~/components/MCPUIResource';
import WorkspaceChanges from './Parts/WorkspaceChanges';
import { renderSiblingHeader } from './ParallelContent';
import EditContentParts from './EditContentParts';
import Sources from '~/components/Web/Sources';
import { renderers } from './Part';

/**
 * What this app adds to the chat package's content renderer: its own part cards, embedded MCP
 * Apps, the workspace changes row, the message editor, search sources, the sibling column header
 * and the query for files a subagent's stored transcript owns. One object for the life of the
 * app, as the renderer requires.
 */
export const contentSlots: ContentPartsSlots = {
  renderers,
  renderAppViews: (attachments) => <MCPAppViews attachments={attachments} />,
  renderApp: (resource, ordinal) => <MCPAppViews resources={[resource]} ordinalStart={ordinal} />,
  useAppsEnabled: () => useMCPAppsPolicy().enabled,
  renderWorkspaceChanges: (changes) => <WorkspaceChanges attachments={changes} />,
  renderEdit: (props) => <EditContentParts {...props} />,
  renderSources: (props) => <Sources {...props} />,
  renderColumnHeader: renderSiblingHeader,
  useSubagentAttachmentCalls: useSubagentAttachmentCallsQueries,
};

/** The package's renderer with this app's slots, for the surfaces that draw it directly. */
export default function ContentParts(props: Omit<ContentPartsProps, 'slots'>) {
  return <ChatContentParts {...props} slots={contentSlots} />;
}
