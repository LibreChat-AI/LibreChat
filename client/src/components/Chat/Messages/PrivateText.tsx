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
interface MissingOriginal {
  canonicalText: string;
  revision: string;
  retryOnCompletion: boolean;
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
  return <ActiveOwnerTextProvider {...props} conversationId={conversationId} />;
}

function ActiveOwnerTextProvider({
  messages,
  conversationId,
  isSubmitting,
  children,
}: OwnerTextProviderProps) {
  const { user } = useAuthContext();
  const selection = useMemo(
    () =>
      JSON.stringify(
        (messages ?? [])
          .filter(
            (message) =>
              message.isCreatedByUser &&
              message.privacyRevision &&
              message.conversationId === conversationId,
          )
          .map((message) => [message.messageId, message.privacyRevision, message.text])
          .sort(),
      ),
    [messages, conversationId],
  );
  const scope = JSON.stringify([user?.id, user?.tenantId, conversationId, selection]);
  const [state, setState] = useState<OwnerTextState>(empty);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const cached = useRef<{
    scope: string;
    messages: Map<string, Original>;
    missing: Map<string, MissingOriginal>;
    retryAttempt: number;
  }>({ scope: '', messages: new Map(), missing: new Map(), retryAttempt: 0 });
  useEffect(() => {
    let cancelled = false;
    const selected = JSON.parse(selection) as Array<[string, string, string]>;
    if (!user?.id || !conversationId || selected.length === 0) {
      cached.current = { scope: '', messages: new Map(), missing: new Map(), retryAttempt };
      setState(empty);
      return;
    }
    const ownerScope = JSON.stringify([user.id, user.tenantId, conversationId]);
    if (cached.current.scope !== ownerScope) {
      cached.current = { scope: ownerScope, messages: new Map(), missing: new Map(), retryAttempt };
    }
    const forceRetry = cached.current.retryAttempt !== retryAttempt;
    cached.current.retryAttempt = retryAttempt;
    const originals = new Map<string, Original>();
    const missing = new Map<string, MissingOriginal>();
    const pending: Array<[string, string, string]> = [];
    for (const [id, revision, text] of selected) {
      const prior = cached.current.messages.get(id);
      if (prior?.revision === revision && prior.canonicalText === text && prior.text != null) {
        originals.set(id, prior);
        continue;
      }
      const missed = cached.current.missing.get(id);
      if (missed?.revision === revision && missed.canonicalText === text) {
        if (!forceRetry && (isSubmitting || !missed.retryOnCompletion)) {
          missing.set(id, missed);
          continue;
        }
      }
      pending.push([id, revision, text]);
    }
    // Do not retain originals or failed reads from removed or edited messages.
    cached.current.messages = originals;
    cached.current.missing = missing;
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
                if (
                  match?.revision === message.revision &&
                  match.text === message.canonicalText &&
                  typeof message.text === 'string'
                ) {
                  const original = {
                    revision: message.revision,
                    text: message.text,
                    canonicalText: message.canonicalText,
                  };
                  originals.set(message.messageId, original);
                  cached.current.messages.set(message.messageId, original);
                }
              }
              for (const [id, revision, text] of batch) {
                if (!originals.has(id)) {
                  missing.set(id, {
                    revision,
                    canonicalText: text,
                    retryOnCompletion: isSubmitting,
                  });
                }
              }
              setState({ scope, messages: new Map(originals), loading: true, retry });
            } catch {
              if (cancelled) {
                return;
              }
              for (const [id, revision, text] of batch) {
                missing.set(id, { revision, canonicalText: text, retryOnCompletion: isSubmitting });
              }
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
  }, [scope, selection, conversationId, user?.id, user?.tenantId, isSubmitting, retryAttempt]);
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
