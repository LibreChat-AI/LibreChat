import { createContext, useContext } from 'react';
import type { MediaAsset, TBalanceResponse } from 'librechat-data-provider';
import type { ComposerProps } from '@librechat/client';
import type { ReactNode } from 'react';

/** Shell-level capabilities the host grants; absent flags read as off. */
export type MediaFeatures = {
  presets: boolean;
  temporary: boolean;
  compare: boolean;
};
export type MediaHost = {
  scope: string;
  userId?: string;
  canCreate: boolean;
  canUseInChat?: boolean;
  balance?: TBalanceResponse;
  refreshBalance?: () => void;
  pollIntervalMs: number;
  catchUpIntervalMs: number;
  enterToSend: boolean;
  resolveKeyVerdict?: ComposerProps['resolveKeyVerdict'];
  isCurrentSession: () => boolean;
  useInChat?: (asset: MediaAsset) => Promise<void>;
  createFromAsset?: (asset: MediaAsset) => void;
  openThread: (threadId: string) => void;
  features?: Partial<MediaFeatures>;
};
export const mediaFeatures = (host: Pick<MediaHost, 'features'>): MediaFeatures => ({
  presets: false,
  temporary: false,
  compare: false,
  ...host.features,
});
const Context = createContext<MediaHost | null>(null);
export function MediaHostProvider({ value, children }: { value: MediaHost; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useMediaHost() {
  const host = useContext(Context);
  if (!host) throw new Error('MediaHostProvider is required');
  return host;
}
