import type { FilesHost } from '@librechat/chat/react';
import { MinimalIcon } from '~/components/Endpoints';

/** The app's capabilities for the attachment components in `@librechat/chat`. */
export const appFilesHost: FilesHost = {
  renderEndpointIcon: (endpoint) => (
    <MinimalIcon endpoint={endpoint} size={14} isCreatedByUser={false} iconClassName="h-3 w-3" />
  ),
};

export { FilesHostProvider, useFilesHost } from '@librechat/chat/react';
