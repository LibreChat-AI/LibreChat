/**
 * Compile-time proof that the chat contract matches what backs it. Nothing here runs; a
 * drift in either direction fails `npm run typecheck`.
 *
 * The hooks annotate their memoized value with the contract, so a member added to or dropped
 * from an implementation without the contract (or the reverse) is already an excess or missing
 * property error there. These assertions cover the rest: the members forwarded from other hooks,
 * whose own signatures could otherwise widen or narrow away from the contract, and the context
 * types consumers read.
 */
import type { ContextType } from 'react';
import type { ChatContract, AddedChatContract, ChatSettings, Transport } from './contract';
import type { ChatTransportContext } from '~/Providers/ChatTransportContext';
import type { ChatSettingsContext } from '~/Providers/ChatSettingsContext';
import type { AddedChatContext } from '~/Providers/AddedChatContext';
import type { ChatContext } from '~/Providers/ChatContext';
import type useAddedResponse from './useAddedResponse';
import type useChatFunctions from './useChatFunctions';
import type useChatHelpers from './useChatHelpers';
import type useNewConvo from '../useNewConvo';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type ChatFunctions = ReturnType<typeof useChatFunctions>;

export type ChatContractChecks = [
  Expect<Equal<ReturnType<typeof useChatHelpers>, ChatContract>>,
  Expect<Equal<ContextType<typeof ChatContext>, ChatContract | null>>,
  Expect<Equal<ChatFunctions['ask'], ChatContract['ask']>>,
  Expect<Equal<ChatFunctions['regenerate'], ChatContract['regenerate']>>,
  Expect<Equal<ReturnType<typeof useNewConvo>['newConversation'], ChatContract['newConversation']>>,
];

export type AddedChatContractChecks = [
  Expect<Equal<ReturnType<typeof useAddedResponse>, AddedChatContract>>,
  Expect<Equal<ContextType<typeof AddedChatContext>, AddedChatContract>>,
];

/** The host supplies settings and transport through the contract's types, nothing wider. */
export type ChatHostContractChecks = [
  Expect<Equal<ContextType<typeof ChatSettingsContext>, ChatSettings>>,
  Expect<Equal<ContextType<typeof ChatTransportContext>, Transport>>,
];
