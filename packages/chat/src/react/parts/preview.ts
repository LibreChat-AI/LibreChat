import { createContext, useContext } from 'react';
import type { Context } from 'react';

/**
 * Whether the parts under this are a picture of a row drawn somewhere else, as a subagent card's
 * row is of its child's thread. A picture paints and nothing more: a part that would register
 * itself with the app, claim something only one mounted row may hold, or act on the reader's
 * behalf does none of that here, because the row it pictures already does.
 */
export const PartsPreviewContext: Context<boolean> = createContext<boolean>(false);

export const useIsPartsPreview = (): boolean => useContext(PartsPreviewContext);
