import { createContext, Suspense, useContext } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  OwnerQueryContext,
  getOwnerQueryClient,
  useOwnerMessageTexts,
} from '~/data-provider/Messages/private';
import { importWithRecovery, lazyWithRecovery } from '~/lib/assets/lazy';
import { useAuthContext } from '~/hooks/AuthContext';
import { useLocalize } from '~/hooks';

const DisplayMessage = lazyWithRecovery(() =>
  importWithRecovery(() => import('./Content/MessageContent')).then((m) => ({
    default: m.DisplayMessage,
  })),
);

interface Original {
  canonicalText: string;
  revision: string;
  text?: string;
}
interface OwnerTextState {
  messages: ReadonlyMap<string, Original>;
  loading: boolean;
  retry?: () => void;
}
const empty: OwnerTextState = { messages: new Map(), loading: false };
const OwnerTextContext = createContext<OwnerTextState>(empty);

interface OwnerTextProviderProps {
  messages: readonly TMessage[] | null;
  conversationId?: string;
  isSubmitting: boolean;
  children: ReactNode;
}

export function OwnerTextProvider(props: OwnerTextProviderProps) {
  const protectedMessage = props.messages?.findLast(
    (message) => message.isCreatedByUser && message.privacyRevision && message.conversationId,
  );
  if (protectedMessage == null) {
    return <>{props.children}</>;
  }
  const conversationId =
    props.conversationId === 'new' &&
    typeof protectedMessage.conversationId === 'string' &&
    protectedMessage.conversationId !== 'new'
      ? protectedMessage.conversationId
      : props.conversationId;
  return <OwnerQueries {...props} conversationId={conversationId} />;
}

function OwnerQueries(props: OwnerTextProviderProps) {
  const applicationClient = useQueryClient();
  return (
    <QueryClientProvider
      client={getOwnerQueryClient(applicationClient)}
      context={OwnerQueryContext}
    >
      <ActiveOwnerTextProvider {...props} />
    </QueryClientProvider>
  );
}

function ActiveOwnerTextProvider({
  messages,
  conversationId,
  isSubmitting,
  children,
}: OwnerTextProviderProps) {
  const { user } = useAuthContext();
  const state = useOwnerMessageTexts({
    messages,
    conversationId,
    isSubmitting,
    userId: user?.id,
    tenantId: user?.tenantId,
  });
  return <OwnerTextContext.Provider value={state}>{children}</OwnerTextContext.Provider>;
}

/** No owner-view data is passed to edit, copy/export, retry, or prompt-building callbacks. */
export function PrivateText({ message }: { message: TMessage }) {
  const localize = useLocalize();
  const state = useContext(OwnerTextContext);
  const original = state.messages.get(message.messageId);
  const text =
    original != null &&
    original.revision === message.privacyRevision &&
    original.canonicalText === message.text
      ? original.text
      : undefined;
  return (
    <div>
      <Suspense fallback={null}>
        <DisplayMessage text={text ?? message.text} isCreatedByUser={true} message={message} />
      </Suspense>
      <p className="text-text-secondary mt-1 text-xs" role="status">
        {localize('com_ui_private_text_hidden')}
        {text == null && (
          <span>
            {' '}
            ·{' '}
            {localize(
              state.loading ? 'com_ui_private_text_loading' : 'com_ui_private_text_unavailable',
            )}
          </span>
        )}
      </p>
      {text == null && !state.loading && state.retry != null && (
        <button type="button" onClick={state.retry} className="text-text-primary text-xs underline">
          {localize('com_ui_private_text_retry')}
        </button>
      )}
    </div>
  );
}
