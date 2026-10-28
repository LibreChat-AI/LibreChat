import type { ComposerHost } from '@librechat/chat/react';
import { useShortcutAriaKey, useShortcutDisplay } from '~/hooks/useKeyboardShortcuts';
import useComposerBindings from '~/hooks/Input/useComposerBindings';

/** The app's capabilities for the composer controls in `@librechat/chat`. */
export const appComposerHost: ComposerHost = {
  useComposerBindings,
  useShortcutDisplay,
  useShortcutAriaKey,
};

export { ComposerHostProvider, useComposerHost } from '@librechat/chat/react';
