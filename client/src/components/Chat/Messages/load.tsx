import { lazy } from 'react';
import { loadScreenMessages } from '@librechat/chat/components';
import type { ChatScreenMessagesProps } from '@librechat/chat/components';
import type { ComponentType, ReactElement } from 'react';
import { importWithRecovery } from '~/lib/assets/lazy';

type MessagesModule = { default: ComponentType<ChatScreenMessagesProps> };

let pending: Promise<MessagesModule> | null = null;

/**
 * Loads the package message list together with the app's hosts, once. A routed
 * conversation and the composer start it early so the list is not fetched only after the
 * conversation's messages arrive; a failed load is dropped so the next attempt retries.
 * The list renders its own pending turn, pending steers and thread mode from those hosts.
 */
export function preloadMessages(): Promise<MessagesModule> {
  pending ??= importWithRecovery(() =>
    Promise.all([loadScreenMessages(), import('./hosts')]).then(([list]) => list),
  ).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** `preloadMessages` already recovers from a stale chunk, so this is a plain `lazy`. */
const Messages = lazy(preloadMessages);

/** The chat screen's message list, drawn once its code has loaded. */
export function renderMessages(props: ChatScreenMessagesProps): ReactElement {
  return <Messages {...props} />;
}
