import { createStorageAtom } from './jotai-utils';

const DEFAULT_SMOOTH_STREAMING = true;

/**
 * Controls whether newly streamed message text fades in smoothly. Purely
 * visual: token delivery and state updates are unaffected, and the CSS
 * animation is disabled under `prefers-reduced-motion`.
 */
export const smoothStreamingAtom = createStorageAtom<boolean>(
  'smoothStreaming',
  DEFAULT_SMOOTH_STREAMING,
);
