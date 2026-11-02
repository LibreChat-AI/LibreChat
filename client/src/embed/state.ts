import { apiBaseUrl } from 'librechat-data-provider';

/** The embed app and host page this framed client belongs to. */
export interface EmbedState {
  app: string;
  origin: string;
}

/** Path the loader frames; the client rewrites it to a chat route once the state is recorded. */
export const EMBED_ENTRY_PATH = '/embed';

const STORAGE_KEY = 'librechat:embed';
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const isFramed = (): boolean => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};

/** Accepts only a bare origin (`https://host[:port]`), the form `event.origin` takes. */
const parseOrigin = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
      ? value
      : null;
  } catch {
    return null;
  }
};

const parseState = (app: string | null, origin: string | null): EmbedState | null => {
  const parsedOrigin = parseOrigin(origin);
  return app && APP_ID_PATTERN.test(app) && parsedOrigin ? { app, origin: parsedOrigin } : null;
};

/** The `sessionStorage` subset embed mode needs; access can throw in a third-party frame. */
export type EmbedStorage = Pick<Storage, 'getItem' | 'setItem'>;

const readStored = (storage: EmbedStorage): EmbedState | null => {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<EmbedState>;
    return parseState(value.app ?? null, value.origin ?? null);
  } catch {
    return null;
  }
};

const store = (storage: EmbedStorage, state: EmbedState) => {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /** Storage can be blocked in a third-party frame; the in-memory copy covers this page load. */
  }
};

/** What the page should do about embed mode: the state to use, and a route to move to. */
export interface EmbedResolution {
  state: EmbedState | null;
  replaceWith?: string;
}

/**
 * Decides embed mode for one page load. The loader frames `/embed?app=…&origin=…`; that entry
 * records the app and host origin for the tab (so a reload of a later chat route keeps embed
 * mode) and is replaced by `/c/new`. Embed mode only applies inside a frame, so a top-level
 * visit to the same deployment is never affected by state a framed session stored.
 */
export function resolveEmbedState({
  framed,
  basePath,
  pathname,
  search,
  storage,
}: {
  framed: boolean;
  basePath: string;
  pathname: string;
  search: string;
  storage: EmbedStorage;
}): EmbedResolution {
  if (!framed) {
    return { state: null };
  }
  if (pathname === `${basePath}${EMBED_ENTRY_PATH}`) {
    const params = new URLSearchParams(search);
    const state = parseState(params.get('app'), params.get('origin'));
    if (state) {
      store(storage, state);
    }
    return { state, replaceWith: `${basePath}/c/new` };
  }
  return { state: readStored(storage) };
}

const WINDOW_NAME_PREFIX = `${STORAGE_KEY}=`;

/**
 * Keeps the state in `window.name`, which survives reloads and in-frame navigation of this frame
 * but no other window. It is the fallback where a browser blocks storage in third-party frames,
 * so a reload (a failed session recovery, the retry button) cannot drop the frame out of embed
 * mode onto the login form. The value is the app id and host origin, nothing secret.
 */
const windowNameStorage: EmbedStorage = {
  getItem: () =>
    window.name.startsWith(WINDOW_NAME_PREFIX)
      ? window.name.slice(WINDOW_NAME_PREFIX.length)
      : null,
  setItem: (_key, value) => {
    window.name = `${WINDOW_NAME_PREFIX}${value}`;
  },
};

/** Reads session storage first and writes both, ignoring whichever the browser blocks. */
export const frameStorage = (): EmbedStorage => {
  let session: Storage | null = null;
  try {
    session = window.sessionStorage;
  } catch {
    session = null;
  }
  return {
    getItem: (key) => {
      try {
        const value = session?.getItem(key);
        if (value) {
          return value;
        }
      } catch {
        /** Blocked; fall through to the window name. */
      }
      return windowNameStorage.getItem(key);
    },
    setItem: (key, value) => {
      try {
        session?.setItem(key, value);
      } catch {
        /** Blocked; the window name still carries the state. */
      }
      windowNameStorage.setItem(key, value);
    },
  };
};

let resolved: EmbedState | null | undefined;

/** Resolves embed mode once per page load (see {@link resolveEmbedState}). */
export function getEmbedState(): EmbedState | null {
  if (resolved !== undefined) {
    return resolved;
  }
  const { state, replaceWith } = resolveEmbedState({
    framed: isFramed(),
    basePath: apiBaseUrl(),
    pathname: window.location.pathname,
    search: window.location.search,
    storage: frameStorage(),
  });
  if (replaceWith) {
    window.history.replaceState(null, '', replaceWith);
  }
  resolved = state;
  return resolved;
}

export const isEmbedded = (): boolean => getEmbedState() != null;
