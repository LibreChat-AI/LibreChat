import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { dataService } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useAuthContext } from '~/hooks/AuthContext';
import { useLocalize } from '~/hooks';
const DisplayMessage = lazy(async () => ({
  default: (await import('./Content/MessageContent')).DisplayMessage,
}));

interface Original {
  canonicalText: string;
  revision: string;
  text?: string;
}
interface OwnerTextState {
  scope: string;
  messages: ReadonlyMap<string, Original>;
  loading: boolean;
  retry?: () => void;
}
const empty: OwnerTextState = { scope: '', messages: new Map(), loading: false };
const OwnerTextContext = createContext<OwnerTextState>(empty);

interface OwnerTextProviderProps {
  messages: readonly TMessage[] | null;
  conversationId?: string;
  isSubmitting: boolean;
  children: ReactNode;
}

export function OwnerTextProvider(props: OwnerTextProviderProps) {
  if (!props.messages?.some((message) => message.isCreatedByUser && message.privacyRevision)) {
    return <>{props.children}</>;
  }
  return <ActiveOwnerTextProvider {...props} />;
}

function ActiveOwnerTextProvider({ messages, conversationId, children }: OwnerTextProviderProps) {
  const { user } = useAuthContext();
  const selection = useMemo(
    () =>
      JSON.stringify(
        (messages ?? [])
          .filter((message) => message.isCreatedByUser && message.privacyRevision)
          .map((message) => [message.messageId, message.privacyRevision, message.text])
          .sort(),
      ),
    [messages],
  );
  const scope = JSON.stringify([user?.id, user?.tenantId, conversationId, selection]);
  const [state, setState] = useState<OwnerTextState>(empty);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const cached = useRef<{ scope: string; messages: Map<string, Original> }>({
    scope: '',
    messages: new Map(),
  });
  useEffect(() => {
    let cancelled = false;
    const selected = JSON.parse(selection) as Array<[string, string, string]>;
    if (!user?.id || !conversationId || selected.length === 0) {
      cached.current = { scope: '', messages: new Map() };
      setState(empty);
      return;
    }
    const ownerScope = JSON.stringify([user.id, user.tenantId, conversationId]);
    if (cached.current.scope !== ownerScope) {
      cached.current = { scope: ownerScope, messages: new Map() };
    }
    const originals = new Map<string, Original>();
    const pending: Array<[string, string, string]> = [];
    for (const [id, revision, text] of selected) {
      const prior = cached.current.messages.get(id);
      if (prior?.revision === revision && prior.canonicalText === text) {
        originals.set(id, prior);
      } else {
        pending.push([id, revision, text]);
      }
    }
    // Do not retain originals from removed or edited messages.
    cached.current.messages = originals;
    const retry = () => setRetryAttempt((attempt) => attempt + 1);
    setState({ scope, messages: new Map(originals), loading: pending.length > 0, retry });
    if (pending.length === 0) {
      return;
    }
    let next = 0;
    const load = async () => {
      const workers = Array.from(
        { length: Math.min(3, Math.ceil(pending.length / 50)) },
        async () => {
          while (next < pending.length) {
            const start = next;
            next += 50;
            const batch = pending.slice(start, start + 50);
            const expected = new Map(batch.map(([id, revision, text]) => [id, { revision, text }]));
            try {
              const result = await dataService.getOwnerMessageTexts(
                conversationId,
                batch.map(([id]) => id),
              );
              if (cancelled) {
                return;
              }
              for (const message of result.messages) {
                const match = expected.get(message.messageId);
                if (match?.revision === message.revision && match.text === message.canonicalText) {
                  const original = {
                    revision: message.revision,
                    text: message.text,
                    canonicalText: message.canonicalText,
                  };
                  originals.set(message.messageId, original);
                  cached.current.messages.set(message.messageId, original);
                }
              }
              setState({ scope, messages: new Map(originals), loading: true, retry });
            } catch {
              // A failed batch does not discard successfully decrypted siblings.
            }
          }
        },
      );
      await Promise.all(workers);
      if (!cancelled) {
        setState({ scope, messages: new Map(originals), loading: false, retry });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [scope, selection, conversationId, user?.id, user?.tenantId, retryAttempt]);
  const visible = state.scope === scope ? state : empty;
  return <OwnerTextContext.Provider value={visible}>{children}</OwnerTextContext.Provider>;
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
      <p className="mt-1 text-xs text-text-secondary" role="status">
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
        <button type="button" onClick={state.retry} className="text-xs text-text-primary underline">
          {localize('com_ui_private_text_retry')}
        </button>
      )}
    </div>
  );
}
