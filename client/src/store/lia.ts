import { createStorageAtom } from './jotai-utils';

const DEFAULT_SHOW_LIA = false;

/**
 * Whether Lia, the welcome screen mascot, is shown. Off until the user opts in, and only
 * offered when the deployment allows it (`interface.mascot`).
 */
export const showLiaAtom = createStorageAtom<boolean>('showLia', DEFAULT_SHOW_LIA);
