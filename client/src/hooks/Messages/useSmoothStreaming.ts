import { useAtomValue } from 'jotai';
import { useMediaQuery } from '@librechat/client';
import { smoothStreamingAtom } from '~/store/smoothStreaming';

/**
 * Whether the smooth streaming fade is enabled for this client: the user
 * setting is on and the device does not prefer reduced motion. Streaming
 * renderers combine this with per-message state (latest message, submitting)
 * to decide whether to animate; the trailing block cursor is hidden while the
 * fade is enabled since the fade itself indicates streaming.
 */
export default function useSmoothStreaming(): boolean {
  const smoothStreaming = useAtomValue(smoothStreamingAtom);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  return smoothStreaming && !reducedMotion;
}
