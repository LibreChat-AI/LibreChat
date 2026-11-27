import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { bindingHash } from '@librechat/chat';
import type { ComposerBindings } from '@librechat/chat';
import type { ShortcutActionId } from '~/hooks/useKeyboardShortcuts';
import { EDITING_ALLOWED_SHORTCUTS, resolveShortcutBindings } from '~/hooks/useKeyboardShortcuts';
import store from '~/store';

export { NO_HOST_BINDINGS } from '@librechat/chat';
export type { ComposerBindings } from '@librechat/chat';

/** The user's effective composer-relevant shortcut bindings, shared by the
 * composer keydown handler and the during-run hovercard hints. */
export default function useComposerBindings(): ComposerBindings {
  const customShortcuts = useRecoilValue(store.customShortcuts);
  const shortcutsEnabled = useRecoilValue(store.shortcutsEnabled);
  const resolvedBindings = useMemo(
    () => resolveShortcutBindings(customShortcuts),
    [customShortcuts],
  );

  const submitOverride = useMemo(() => {
    if (!shortcutsEnabled) {
      return null;
    }
    const override = customShortcuts['submitMessage'];
    if (!override) {
      return resolvedBindings.get('submitMessage') == null ? null : undefined;
    }
    return resolvedBindings.get('submitMessage') ?? null;
  }, [customShortcuts, resolvedBindings, shortcutsEnabled]);

  const yieldedChords = useMemo(() => {
    if (!shortcutsEnabled) {
      return new Set<string>();
    }
    const editingAllowed: ReadonlySet<string> = EDITING_ALLOWED_SHORTCUTS;
    const hashes = new Set<string>();
    for (const actionId of editingAllowed) {
      if (actionId === 'submitMessage') {
        continue;
      }
      const binding = resolvedBindings.get(actionId as ShortcutActionId);
      if (binding) {
        hashes.add(bindingHash(binding));
      }
    }
    return hashes;
  }, [resolvedBindings, shortcutsEnabled]);

  return useMemo(
    () => ({ shortcutsEnabled, submitOverride, yieldedChords }),
    [shortcutsEnabled, submitOverride, yieldedChords],
  );
}
