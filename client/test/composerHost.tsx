import React from 'react';
import { ComposerHostProvider } from '@librechat/chat/react';
import { appComposerHost } from '~/Providers/ComposerHostContext';

/** Mounts the app's composer host the way `routes/Root.tsx` does, for specs that render the
 *  composer controls outside the app shell. Import it after the spec's module mocks so the host
 *  uses them. */
export function ComposerHostTestProvider({ children }: { children?: React.ReactNode }) {
  return <ComposerHostProvider host={appComposerHost}>{children}</ComposerHostProvider>;
}
