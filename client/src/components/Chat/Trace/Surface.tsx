import { Suspense, useId, useRef, useState, useEffect } from 'react';
import { useAtom } from 'jotai';
import { X } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import type { ReactNode } from 'react';
import { traceViewerConversationAtom } from './store';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** The trace viewer opens on demand, so it loads then instead of with the chat. */
const Viewer = lazyWithRecovery(() => import('./Viewer'));

/**
 * Stands in for the viewer while its chunk downloads. It covers the chat, which is inert
 * meanwhile, so it keeps the viewer's header: the close button and Escape dismiss it, and a
 * slow or stalled download never traps the conversation.
 */
function ViewerLoading({ onClose }: { onClose: () => void }) {
  const localize = useLocalize();
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <section
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
      className="bg-surface-primary-alt text-text-primary absolute inset-0 z-20 flex flex-col"
    >
      <div className="border-border-light flex h-[52px] shrink-0 items-center gap-2 border-b px-2 md:px-4">
        <h2 id={headingId} className="text-base font-semibold">
          {localize('com_ui_trace_title')}
        </h2>
        <Button
          ref={closeRef}
          size="icon-sm"
          variant="outline"
          className="ms-auto"
          aria-label={localize('com_ui_trace_close')}
          onClick={onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div role="status" className="text-text-secondary flex flex-1 items-center justify-center">
        <Spinner size={24} />
        <span className="sr-only">{localize('com_ui_loading')}</span>
      </div>
    </section>
  );
}

/**
 * Hosts the trace over the chat without unmounting it: the chat stays mounted
 * and inert underneath, so closing the trace restores its scroll position,
 * composer draft and focus target exactly as they were.
 */
export default function TraceSurface({
  conversationId,
  children,
}: {
  conversationId?: string | null;
  children: ReactNode;
}) {
  const [traceConversationId, setTraceConversationId] = useAtom(traceViewerConversationAtom);
  const open = conversationId != null && traceConversationId === conversationId;

  /** What had focus when the trace opened, read before the loading fallback or the viewer
   *  moves focus into the trace, so either one returns it there when the trace closes. */
  const [wasOpen, setWasOpen] = useState(open);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    }
  }

  useEffect(() => {
    if (open || opener == null) {
      return;
    }
    /** Only reclaim focus the trace took with it, as the viewer does. */
    const active = document.activeElement;
    if (active != null && active !== document.body) {
      return;
    }
    const target = opener.isConnected ? opener : document.getElementById('header-menu-button');
    target?.focus();
  }, [open, opener]);

  useEffect(() => {
    if (traceConversationId != null && traceConversationId !== conversationId) {
      setTraceConversationId(null);
    }
  }, [conversationId, traceConversationId, setTraceConversationId]);

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* `isolate` while covered: the chat's own layers (the message rail sits at
          z-40) would otherwise stack above the trace. */}
      <div
        className={cn('flex h-full w-full flex-col', open && 'isolate')}
        inert={open ? '' : undefined}
      >
        {children}
      </div>
      {open && (
        <Suspense fallback={<ViewerLoading onClose={() => setTraceConversationId(null)} />}>
          <Viewer
            conversationId={conversationId}
            returnFocusTo={opener}
            onClose={() => setTraceConversationId(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
