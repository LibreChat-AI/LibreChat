import { useSyncExternalStore } from 'react';

type Direction = 'ltr' | 'rtl';

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
  return () => observer.disconnect();
};

const getSnapshot = (): Direction => (document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr');

const getServerSnapshot = (): Direction => 'ltr';

/** Reads the document direction and re-renders when `<html dir>` changes. */
export default function useDocumentDirection(): Direction {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
