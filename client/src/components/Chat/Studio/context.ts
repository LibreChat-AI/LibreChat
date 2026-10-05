import { createContext, useContext } from 'react';

/** Whether chat images may offer "Open in Studio". The host computes it once per chat view so
 * each image reads a boolean instead of running the auth, permission, share and config hooks. */
export const StudioContext = createContext(false);

export function useStudioAvailable(): boolean {
  return useContext(StudioContext);
}
