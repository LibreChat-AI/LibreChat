import { createContext, useContext } from 'react';
type TShareContext = {
  isSharedConvo?: boolean;
  shareId?: string;
  /** Whether the link was published with a configured sender label. No conversation
   *  is in scope under a share link, so the header reads it here. */
  hasConfiguredSender?: boolean;
};

export const ShareContext = createContext<TShareContext>({} as TShareContext);
export const useShareContext = () => useContext(ShareContext);
