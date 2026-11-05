import { useEffect, useMemo, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import { ContentTypes, dataService } from 'librechat-data-provider';
import {
  ShieldCheck,
  ExternalLink,
  RotateCw,
  CheckCircle2,
  XCircle,
  TriangleAlert,
} from 'lucide-react';
import type { Agents } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useMessageContext, useOptionalMessagesOperations } from '~/Providers';
import { useLocalize } from '~/hooks';
import cn from '~/utils/cn';

type ElicitationAction = Agents.ElicitationAction;

function getStatusText(
  resolvedAction: ElicitationAction,
  localize: (key: TranslationKeys) => string,
): string {
  if (resolvedAction === 'accept') {
    return localize('com_ui_elicitation_completed');
  }
  if (resolvedAction === 'complete') {
    return localize('com_ui_elicitation_authorized');
  }
  if (resolvedAction === 'cancel') {
    return localize('com_ui_elicitation_cancelled');
  }
  return localize('com_ui_elicitation_declined');
}

/** Only `http(s)` targets are safe to render as a clickable link — a malicious or
 *  compromised MCP server could otherwise supply a `javascript:`/`data:` URL that
 *  executes script in the LibreChat origin the moment the user clicks it. */
function getSafeUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Hostname of a URL already known to be a safe http(s) target (see
 *  `getSafeUrl`) — used to highlight the domain the user is about to visit,
 *  mitigating long-path/subdomain spoofing where the real host is buried. */
function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** True when any label of the hostname is IDNA/Punycode-encoded (`xn--...`).
 *  The URL parser itself converts any non-ASCII (mixed-script/homograph)
 *  hostname label to its `xn--` form, so this single check also catches
 *  Cyrillic/Greek lookalike domains — not just literal Punycode input. */
function hasPunycodeLabel(hostname: string): boolean {
  return hostname.split('.').some((label) => label.toLowerCase().startsWith('xn--'));
}

/** Header chrome for the card: a tinted circular icon, a title, and the
 *  requesting server/tool identity. Keeps the card visually native to LibreChat's
 *  other in-chat system cards (see `ToolCall` OAuth sign-in). */
function CardHeader({
  icon,
  title,
  identity,
}: {
  icon: ReactNode;
  title: string;
  identity?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="bg-surface-tertiary text-text-secondary flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-text-primary text-sm font-medium">{title}</p>
        {identity && <p className="text-text-secondary truncate text-xs">{identity}</p>}
      </div>
    </div>
  );
}

/** Button label with a stable footprint: when `acting`, the label is kept in the
 *  layout but hidden, and the Spinner is overlaid — so a click never shifts the row. */
function ActionLabel({
  label,
  icon,
  acting,
}: {
  label: string;
  icon?: ReactNode;
  acting: boolean;
}) {
  return (
    <span className="relative inline-flex items-center justify-center gap-2">
      <span className={cn('inline-flex items-center gap-2', acting && 'invisible')}>
        {icon}
        {label}
      </span>
      {acting && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size={16} />
        </span>
      )}
    </span>
  );
}

/**
 * Renders an in-chat card for MCP URL-mode elicitation (spec 2025-11-25):
 * either a `mode: 'url'` `elicitation/create` request, or the -32042
 * URL-exception path on `tools/call`. It shows a message, a prominent
 * authorization link (full URL visible, domain highlighted, homograph-warned),
 * and Continue/Cancel. Continue posts `action: 'complete'`, which resumes/retries
 * the suspended tool call server-side via `POST /api/mcp/elicitation/:flowId`
 * (`dataService.respondToElicitation`), mirroring the OAuth "visit a URL, then
 * get resumed" flow already used elsewhere in MCP tool calls.
 */
export default function ElicitationForm({
  flowId,
  message,
  serverName,
  toolName,
  url,
  action: initialAction,
}: Agents.ElicitationContent['elicitation']) {
  const localize = useLocalize();
  const { messageId } = useMessageContext();
  const { getMessages, setMessages } = useOptionalMessagesOperations();
  const [pendingAction, setPendingAction] = useState<ElicitationAction | undefined>();
  const [sendFailed, setSendFailed] = useState(false);
  // Track whether the user has opened this flow's authorization link. When there
  // is no link to open, there is nothing to gate on, so treat it as already opened.
  const [urlOpened, setUrlOpened] = useState(!url);
  const [resolvedAction, setResolvedAction] = useState<ElicitationAction | undefined>(
    initialAction,
  );
  // `initialAction` can arrive/change after mount when resolution comes in via
  // the `on_elicitation_resolved` SSE event (or a history replay) — which patches
  // the message's content part — rather than this component's own `submitAction`.
  // Sync it so the card reflects the resolved state instead of staying interactive.
  useEffect(() => {
    if (initialAction != null) {
      setResolvedAction(initialAction);
    }
  }, [initialAction]);

  const submitting = pendingAction != null;
  const identity = [serverName, toolName].filter(Boolean).join(' · ') || undefined;
  // Never render the server-supplied `url` as an href unless it's http(s) — see
  // `getSafeUrl`. A present-but-unsafe `url` renders a warning instead of a link
  // and permanently withholds the `urlOpened` unlock (no link, nothing to click).
  const safeUrl = useMemo(() => getSafeUrl(url), [url]);
  // Domain highlight + Punycode/homograph warning, shown alongside the full URL
  // text so the user can examine the real destination before clicking anything.
  const hostname = useMemo(() => (safeUrl ? getHostname(safeUrl) : ''), [safeUrl]);
  const suspiciousHostname = useMemo(() => hasPunycodeLabel(hostname), [hostname]);

  /** Writes the resolved `action` onto this flow's `ELICITATION` content part in
   *  the owning message, so the resolved state isn't held only in this
   *  component's local `resolvedAction` state. Mirrors the write-back
   *  `useStepHandler` applies for the `on_elicitation_resolved` SSE event. A no-op
   *  when rendered outside a `MessagesViewProvider`. */
  const patchResolvedElicitation = (action: ElicitationAction) => {
    const messages = getMessages();
    if (!messages) {
      return;
    }
    let didPatch = false;
    const updatedMessages = messages.map((msg) => {
      if (msg.messageId !== messageId || !msg.content) {
        return msg;
      }
      const updatedContent = msg.content.map((part) => {
        if (part?.type !== ContentTypes.ELICITATION || part.elicitation?.flowId !== flowId) {
          return part;
        }
        didPatch = true;
        return {
          ...part,
          elicitation: { ...part.elicitation, action },
        };
      });
      return { ...msg, content: updatedContent };
    });
    if (didPatch) {
      setMessages(updatedMessages);
    }
  };

  const submitAction = async (action: ElicitationAction) => {
    setSendFailed(false);
    setPendingAction(action);
    try {
      await dataService.respondToElicitation(flowId, { action });
      setResolvedAction(action);
      patchResolvedElicitation(action);
    } catch (error) {
      // A 409 means the completion route atomically lost the race (e.g. the
      // same card acted on in another tab, or a double-submit) — the flow IS
      // resolved, just not by this request. Treat it like the success path
      // instead of a misleading "try again".
      const response = (
        error as { response?: { status?: number; data?: { action?: ElicitationAction } } }
      )?.response;
      const status = response?.status;
      if (status === 409) {
        /** Render what actually won, not what this request tried: another tab may
         *  have declined while this one submitted an accept. The route returns the
         *  settled action; fall back to ours only if it is somehow absent. */
        const settledAction = response?.data?.action ?? action;
        setResolvedAction(settledAction);
        patchResolvedElicitation(settledAction);
      } else {
        // Surface an inline retry affordance; the server-side flow keeps waiting
        // (or times out on its own), so the card stays interactive for a retry.
        setSendFailed(true);
      }
    } finally {
      setPendingAction(undefined);
    }
  };

  const markUrlOpened = () => setUrlOpened(true);

  const errorLine = sendFailed ? (
    <p role="alert" className="text-text-destructive text-xs">
      {localize('com_ui_elicitation_error')}
    </p>
  ) : null;

  // Announced via the permanently-mounted `sr-only` span below, decoupled from
  // the visible card's mount/unmount — mirrors `ToolCall`/`WebSearch`/
  // `RetrievalCall`/`CodeAnalyze`, whose live region persists across state
  // changes rather than mounting fresh alongside its own content.
  const statusText = resolvedAction ? getStatusText(resolvedAction, localize) : '';

  let card: ReactNode;
  if (resolvedAction) {
    const succeeded = resolvedAction === 'accept' || resolvedAction === 'complete';
    // Once resolved, recede to a muted one-line trace at the sibling tool call's
    // "Completed …" altitude rather than lingering as a full card.
    card = (
      <div className="text-text-secondary my-1.5 flex h-5 items-center gap-2">
        {succeeded ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="text-xs">{statusText}</span>
      </div>
    );
  } else {
    card = (
      <div className="border-border-light bg-surface-secondary my-2 rounded-xl border p-4">
        <div className="flex flex-col gap-3">
          <CardHeader
            icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            title={localize('com_ui_elicitation_title')}
            identity={identity}
          />
          <p className="text-text-secondary text-sm">{message}</p>
          {/* MUST be visible and readable before the user clicks anything — see
              `getSafeUrl`/`getHostname`/`hasPunycodeLabel`. Rendered above the
              button row regardless of `urlOpened` so it stays available to
              re-examine before Continue, too. */}
          {safeUrl && (
            <div className="border-border-light bg-surface-tertiary flex flex-col gap-1 rounded-lg border p-2.5">
              <p className="text-text-secondary text-xs">
                {localize('com_ui_elicitation_url_domain_label')}{' '}
                <span className="text-text-primary font-semibold">{hostname}</span>
              </p>
              <p title={safeUrl} className="text-text-secondary text-xs break-all">
                {safeUrl}
              </p>
              {suspiciousHostname && (
                <p role="alert" className="text-text-warning flex items-center gap-1.5 text-xs">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {localize('com_ui_elicitation_suspicious_url')}
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {!urlOpened ? (
              <>
                {safeUrl ? (
                  <Button
                    asChild
                    variant="submit"
                    size="sm"
                    aria-disabled={submitting || undefined}
                    className={cn(submitting && 'pointer-events-none')}
                  >
                    <a
                      href={safeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      tabIndex={submitting ? -1 : undefined}
                      onClick={markUrlOpened}
                      onAuxClick={markUrlOpened}
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      {localize('com_ui_elicitation_open_url')}
                    </a>
                  </Button>
                ) : (
                  url && (
                    <p role="alert" className="text-text-destructive text-xs">
                      {localize('com_ui_elicitation_invalid_url')}
                    </p>
                  )
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={submitting || !urlOpened}
                  onClick={() => submitAction('complete')}
                >
                  <ActionLabel
                    label={localize('com_ui_elicitation_continue')}
                    acting={pendingAction === 'complete'}
                  />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="submit"
                  size="sm"
                  disabled={submitting}
                  onClick={() => submitAction('complete')}
                >
                  <ActionLabel
                    label={localize('com_ui_elicitation_continue')}
                    acting={pendingAction === 'complete'}
                  />
                </Button>
                {safeUrl && (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    aria-disabled={submitting || undefined}
                    className={cn(submitting && 'pointer-events-none')}
                  >
                    <a
                      href={safeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      tabIndex={submitting ? -1 : undefined}
                      onClick={markUrlOpened}
                      onAuxClick={markUrlOpened}
                    >
                      <RotateCw className="h-4 w-4" aria-hidden="true" />
                      {localize('com_ui_elicitation_reopen')}
                    </a>
                  </Button>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => submitAction('cancel')}
            >
              <ActionLabel
                label={localize('com_ui_elicitation_cancel')}
                acting={pendingAction === 'cancel'}
              />
            </Button>
          </div>
          {errorLine}
        </div>
      </div>
    );
  }

  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>
      {card}
    </>
  );
}
