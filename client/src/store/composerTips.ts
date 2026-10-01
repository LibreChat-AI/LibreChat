import { createStorageAtom } from './jotai-utils';

/** Whether the composer displays its keyboard shortcut discovery hints. */
export const showComposerTipsAtom = createStorageAtom<boolean>('showComposerTips', false);
