import { ActivityPhaseGroup as PackageActivityPhaseGroup } from '@librechat/chat/components';
import type { ActivityPhaseGroupProps } from '@librechat/chat/components';
import type { TAttachment } from 'librechat-data-provider';
import { MCPAppViews } from '~/components/MCPUIResource';
/** Registers the app's host, which the phase reads its settings and MCP catalog from. */
import '~/Providers/MessagePartsHostContext';

export { PhaseLabel } from '@librechat/chat/components';

const renderAppViews = (attachments: TAttachment[]) => <MCPAppViews attachments={attachments} />;

/** App adapter: the embedded MCP app views under a phase's files are the app's. */
export default function ActivityPhaseGroup(props: Omit<ActivityPhaseGroupProps, 'renderAppViews'>) {
  return <PackageActivityPhaseGroup {...props} renderAppViews={renderAppViews} />;
}
