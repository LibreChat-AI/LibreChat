import { createContext, useContext } from 'react';
import type { Context, ReactNode } from 'react';

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
export const AuthorContext: Context<TMessageAuthor | null> = createContext<TMessageAuthor | null>(
  null,
);
export const useAuthorContext = (): TMessageAuthor | null => useContext(AuthorContext);

/**
 * Who wrote a list's user-side turns, when that is not the reader. A conversation the reader
 * follows can hold such turns: a subagent's brief comes from the agent that dispatched it. A
 * list under this context draws them with this author's name and face, shown, instead of the
 * reader's.
 */
export const UserTurnAuthorContext: Context<TMessageAuthor | undefined> = createContext<
  TMessageAuthor | undefined
>(undefined);
export const useUserTurnAuthor = (): TMessageAuthor | undefined =>
  useContext(UserTurnAuthorContext);
