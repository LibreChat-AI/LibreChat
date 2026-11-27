import { createContext } from 'react';

/**
 * The end of the enclosing fold header, just inside its chevron. A call whose
 * own row a generated title replaced renders its row action here, so the
 * action stays on the title line instead of floating over the panel's edge.
 */
export const HeaderActionSlotContext = createContext<HTMLElement | null>(null);
