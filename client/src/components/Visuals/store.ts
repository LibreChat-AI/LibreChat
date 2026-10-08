import { createStorageAtom } from '~/store/jotai-utils';

/**
 * Whether assistants may draw inline visuals in this user's chats. On by default, and only
 * offered when the deployment allows visuals (`interface.visuals`).
 */
export const inlineVisualsAtom = createStorageAtom<boolean>('inlineVisuals', true);
