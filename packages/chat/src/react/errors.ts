import { useMemo, useSyncExternalStore } from 'react';
import type { ErrorEndpoint, ErrorEnvironment, ErrorSource } from '../core/errors';
import type { AgentBuilderAccess, MessagePartsBalanceDisplay } from './host';
import { resolveErrorEndpoint } from '../core/errors';
import { useMessagePartsHost } from './host';

const NO_ENVIRONMENT: ErrorEnvironment = {};
const useNoEnvironment = (): ErrorEnvironment => NO_ENVIRONMENT;

const NO_BUILDER: AgentBuilderAccess = { canUseBuilder: false, isAdmin: false };
const useNoBuilder = (): AgentBuilderAccess => NO_BUILDER;

const CREDITS: MessagePartsBalanceDisplay = { display: 'credits' };
const useCredits = (): MessagePartsBalanceDisplay => CREDITS;

/**
 * Who produced a failure: the row's own identity, resolved against what the host knows about the
 * chat it renders in (`useErrorEnvironment`). Error content renders in the chat, in search results
 * and in shared links, so the copy reading this has to work without a provider name.
 */
export function useErrorEndpoint(source?: ErrorSource, payloadEndpoint?: string): ErrorEndpoint {
  const useEnvironment = useMessagePartsHost().useErrorEnvironment ?? useNoEnvironment;
  const environment = useEnvironment(source);
  return useMemo(
    () => resolveErrorEndpoint(source, payloadEndpoint, environment),
    [source, payloadEndpoint, environment],
  );
}

/** Whether the reader may open the agent builder; nobody may where the host does not say. */
export function useAgentBuilderAccess(): AgentBuilderAccess {
  const useAccess = useMessagePartsHost().useAgentBuilderAccess ?? useNoBuilder;
  return useAccess();
}

/** How the deployment shows balances; credits where the host does not say. */
export function useBalanceDisplay(): MessagePartsBalanceDisplay {
  const useDisplay = useMessagePartsHost().useBalanceDisplay ?? useCredits;
  return useDisplay();
}

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

/** `navigator.onLine` is only trustworthy when false: a captive portal or a dead
 *  route still reports true. Use it to name the cause of a failure, never to block a request. */
const getSnapshot = () => navigator.onLine;
const getServerSnapshot = () => true;

/** Whether the browser reports a network connection. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
