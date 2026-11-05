import React from 'react';
import { SteerHostProvider } from '@librechat/chat/react';
import { appSteerHost } from '~/Providers/SteerHostContext';

/** Mounts the app's steer host the way `routes/Root.tsx` does, for specs that render the steer
 *  hooks outside the app shell. Import it after the spec's module mocks so the host uses them. */
export function SteerHostTestProvider({ children }: { children?: React.ReactNode }) {
  return <SteerHostProvider host={appSteerHost}>{children}</SteerHostProvider>;
}
