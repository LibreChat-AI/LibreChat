import { Suspense, useEffect } from 'react';
import { useAtom } from 'jotai';
import { Spinner } from '@librechat/client';
import type { ReactNode } from 'react';
import { traceViewerConversationAtom } from './store';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** The trace viewer opens on demand, so it loads then instead of with the chat. */
const Viewer = lazyWithRecovery(() => import('./Viewer'));

function ViewerLoading() {
  const localize = useLocalize();
  return (
    <div
      role="status"
      className="bg-surface-primary-alt text-text-secondary absolute inset-0 z-20 flex items-center justify-center"
    >
      <Spinner size={24} />
      <span className="sr-only">{localize('com_ui_loading')}</span>
    </div>
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
        <Suspense fallback={<ViewerLoading />}>
          <Viewer conversationId={conversationId} onClose={() => setTraceConversationId(null)} />
        </Suspense>
      )}
    </div>
  );
}
