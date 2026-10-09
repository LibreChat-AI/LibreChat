import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/** The author a message restates wherever its content resumes after a steer. */
export type TMessageAuthor = {
  icon: ReactNode;
  label: string;
};

/**
 * Carries the message author to the headers inside its content. The author can
 * resolve after the message paints, when an agent's name and avatar arrive with the
 * agents list, and a context change reaches only the headers that read it rather
 * than every part of the message.
 */
export const AuthorContext = createContext<TMessageAuthor | null>(null);
export const useAuthorContext = () => useContext(AuthorContext);
