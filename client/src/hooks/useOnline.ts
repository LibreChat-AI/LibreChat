import { useSyncExternalStore } from 'react';

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

/** `navigator.onLine` is only trustworthy when false: a captive portal or a dead
 *  route still reports true. Use it to name the cause of a failure, never to block a request. */
const getSnapshot = () => navigator.onLine;
const getServerSnapshot = () => true;

export default function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
