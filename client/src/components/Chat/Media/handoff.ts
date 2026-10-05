import { useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import type { MediaAsset } from 'librechat-data-provider';
import { mediaChatHandoff } from '~/components/Media/handoff';

/** Claim before attaching: the file update rerenders the composer before the promise settles. */
export function useMediaChatHandoff({
  scope,
  conversationId,
  ready,
  isCurrentSession,
  attach,
  onError,
}: {
  scope?: string;
  conversationId: string;
  ready: boolean;
  isCurrentSession?: () => boolean;
  attach: (asset: MediaAsset) => Promise<void>;
  onError: () => void;
}) {
  const [handoff, setHandoff] = useAtom(mediaChatHandoff);
  const attempt = useRef<{
    handoff: typeof handoff;
    attach: typeof attach;
    phase: 'pending' | 'done' | 'failed';
  }>();
  useEffect(() => {
    const previous = attempt.current;
    if (
      !handoff ||
      (previous?.handoff === handoff &&
        (previous.phase !== 'failed' || previous.attach === attach)) ||
      handoff.scope !== scope ||
      handoff.conversationId !== conversationId ||
      !ready ||
      !isCurrentSession?.()
    )
      return;
    const current = { handoff, attach, phase: 'pending' as 'pending' | 'done' | 'failed' };
    attempt.current = current;
    void attach(handoff.asset)
      .then(() => {
        current.phase = 'done';
        if (isCurrentSession()) setHandoff((current) => (current === handoff ? null : current));
      })
      .catch(() => {
        current.phase = 'failed';
        if (isCurrentSession()) onError();
      });
  }, [handoff, scope, conversationId, ready, isCurrentSession, attach, onError, setHandoff]);
  return { dismiss: () => setHandoff((current) => (current?.scope === scope ? null : current)) };
}
