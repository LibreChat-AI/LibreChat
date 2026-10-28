import React from 'react';
import { StreamHostProvider } from '@librechat/chat/react';
import { appStreamHost } from '~/Providers/StreamHostContext';

/** Mounts the app's stream host the way `routes/Root.tsx` does, for specs that render the stream
 *  hooks outside the app shell. Import it after the spec's module mocks so the host uses them. */
export function StreamHostTestProvider({ children }: { children?: React.ReactNode }) {
  return <StreamHostProvider host={appStreamHost}>{children}</StreamHostProvider>;
}
