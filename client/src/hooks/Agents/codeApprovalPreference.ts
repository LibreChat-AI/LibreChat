import { useAtom } from 'jotai';
import { CODE_APPROVAL_MODES, LocalStorageKeys } from 'librechat-data-provider';
import type { CodeApprovalMode } from 'librechat-data-provider';
import { createStorageAtom } from '~/store/jotai-utils';

const preference = createStorageAtom<string | null>(LocalStorageKeys.LAST_CODE_APPROVAL_MODE, null);

function validMode(saved: string | null): CodeApprovalMode | undefined {
  return (CODE_APPROVAL_MODES as readonly string[]).includes(saved ?? '')
    ? (saved as CodeApprovalMode)
    : undefined;
}

/**
 * The mode the reader last picked in this browser, so a new chat opens the way
 * they left the last one instead of falling back to `ask` every time. A
 * disposable hint and never authorization: the caller re-checks it against the
 * modes current policy allows before showing or submitting it, and logout
 * clears it with the rest of this browser's conversation state.
 */
export function useCodeApprovalModePreference() {
  const [saved, setSaved] = useAtom(preference);
  return {
    get: () => validMode(saved),
    remember: (mode: CodeApprovalMode) => {
      try {
        setSaved(mode);
      } catch {
        // Disabled or full browser storage must not prevent an explicit pick.
      }
    },
  };
}
