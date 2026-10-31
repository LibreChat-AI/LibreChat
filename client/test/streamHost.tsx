import React from 'react';
import { StreamHostProvider } from '@librechat/chat/react';
import type { StreamHost } from '@librechat/chat/react';
import { useParentSubagentIndex } from '~/data-provider/Subagents/parents';
import { appStreamHost } from '~/Providers/StreamHostContext';

/** Mounts the app's stream host the way `routes/Root.tsx` does, for specs that render the stream
 *  hooks outside the app shell. Import it after the spec's module mocks so the host uses them. */
export function StreamHostTestProvider({ children }: { children?: React.ReactNode }) {
  return <StreamHostProvider host={appStreamHost}>{children}</StreamHostProvider>;
}

const unused = (member: string) => () => {
  throw new Error(`${member} is not part of the subagent index test host`);
};

/** A stream host that serves only the parent subagent index, from the app's real query, for
 *  specs that render the subagent provider without the stream bindings. */
export const subagentIndexHost: StreamHost = {
  useResumableServices: unused('useResumableServices'),
  useLegacyStream: unused('useLegacyStream'),
  useTransport: () => null,
  useQueuedTurnReceipts: unused('useQueuedTurnReceipts'),
  useActiveJobs: unused('useActiveJobs'),
  extendActiveJobsGrace: unused('extendActiveJobsGrace'),
  useStreamStatus: unused('useStreamStatus'),
  useResumeSettings: unused('useResumeSettings'),
  useParentSubagentIndex,
};

export function SubagentIndexHostProvider({ children }: { children?: React.ReactNode }) {
  return <StreamHostProvider host={subagentIndexHost}>{children}</StreamHostProvider>;
}
