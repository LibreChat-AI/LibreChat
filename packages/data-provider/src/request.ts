/* eslint-disable @typescript-eslint/no-explicit-any */
import axios, { AxiosHeaders } from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type * as t from './types';
import { TWO_FACTOR_ENROLLMENT_REQUIRED_CODE, AUTH_SESSION_CHECK_UNAVAILABLE } from './config';
import { persistTwoFactorSetupToken } from './twoFactor';
import { setTokenHeader } from './headers-helpers';
import { getClientLimit } from './clientLimits';
import * as endpoints from './api-endpoints';

async function _get<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.get(url, { ...options });
  return response.data;
}

async function _getResponse<T = unknown>(
  url: string,
  options?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  return await axios.get<T>(url, { ...options });
}

async function _post(url: string, data?: any, options?: AxiosRequestConfig) {
  const response = await axios.post(url, JSON.stringify(data), {
    ...options,
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

async function _postMultiPart(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

async function _postTTS(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
    responseType: 'arraybuffer',
  });
  return response.data;
}

async function _put(url: string, data?: any) {
  const response = await axios.put(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

async function _delete<T>(url: string): Promise<T> {
  const response = await axios.delete(url);
  return response.data;
}

async function _deleteWithOptions<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.delete(url, { ...options });
  return response.data;
}

async function _patch(url: string, data?: any) {
  const response = await axios.patch(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

const AUTH_RECOVERY_EVENT = 'authRecovery';
const AUTH_REDIRECT_EVENT = 'authRedirectStarted';
const AUTH_UNAVAILABLE_EVENT = 'authSessionUnavailable';
const AUTH_REDIRECT_STORAGE_KEY = 'librechat.auth.redirect.startedAt';
const AUTH_REDIRECT_DEDUPE_MS = 15_000;
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

type RetryableAxiosRequestConfig = AxiosRequestConfig & {
  _retry?: boolean;
  /** Marks a refresh call dispatched by startAuthRecovery, independent of the
   *  generation-cleared refreshPromise, so its own failure is never retried. */
  _managedRefresh?: boolean;
};

type AuthRecoveryState = {
  lastRedirectStartedAt: number;
  refreshPromise: Promise<string | null> | null;
  /** Bumped on login, logout and confirmed denial so a refresh response from a
   *  superseded account can be recognized and ignored. */
  generation: number;
};

type RefreshFailureClassification = 'unavailable' | 'denied';

/** Only a 503 carrying the session-check-unavailable code is a temporary failure the server
 *  itself distinguished from a denial; every other failure (network error, timeout, other
 *  5xx/4xx) is a denial, since the client cannot otherwise tell a down check from an ended one. */
const classifyRefreshFailure = (error: unknown): RefreshFailureClassification => {
  const response = (error as { response?: { status?: number; data?: unknown } } | undefined)
    ?.response;
  const code = (response?.data as { code?: unknown } | undefined)?.code;
  return response?.status === 503 && code === AUTH_SESSION_CHECK_UNAVAILABLE
    ? 'unavailable'
    : 'denied';
};

type ProactiveRefreshFailureClassification = RefreshFailureClassification | 'network';

/** Narrows the proactive path's handling of a rejected refresh beyond `classifyRefreshFailure`'s
 *  binary split: a network error or timeout carries no `response` at all, so it is told apart
 *  from an actual denial without re-deriving the unavailable check. */
const classifyProactiveRefreshFailure = (error: unknown): ProactiveRefreshFailureClassification => {
  const classification = classifyRefreshFailure(error);
  if (classification === 'unavailable') {
    return 'unavailable';
  }
  const hasResponse = (error as { response?: unknown } | undefined)?.response != null;
  return hasResponse ? 'denied' : 'network';
};

const AUTH_SESSION_UNAVAILABLE_MARKER = '__authSessionUnavailable';

type MarkedUnavailable = { [AUTH_SESSION_UNAVAILABLE_MARKER]?: true };

/** The interceptor re-throws the original 401 so the caller's error stays recognizable; marking
 *  it is what lets a consumer tell that rethrown 401 apart from a plain denial. */
const markAuthSessionUnavailable = <T>(target: T): T => {
  if (target != null && typeof target === 'object') {
    (target as MarkedUnavailable)[AUTH_SESSION_UNAVAILABLE_MARKER] = true;
  }
  return target;
};

/** True for an error the interceptor marked while classifying its own refresh failure as
 *  unavailable, or for a raw unavailable response passed in directly. */
const isAuthSessionUnavailableError = (error: unknown): boolean =>
  classifyRefreshFailure(error) === 'unavailable' ||
  (error != null &&
    typeof error === 'object' &&
    (error as MarkedUnavailable)[AUTH_SESSION_UNAVAILABLE_MARKER] === true);

type AuthRecoveryWindow = Window & {
  __librechatAuthRecovery?: AuthRecoveryState;
};

/** A hung refresh gates every API call through the deduped recovery promise, so it must reject. */
const refreshToken = (
  retry?: boolean,
  config?: RetryableAxiosRequestConfig,
): Promise<t.TRefreshTokenResponse | undefined> =>
  _post(endpoints.refreshToken(retry), undefined, {
    timeout: getClientLimit('refreshMs'),
    ...config,
  });

const SHARE_PAGE_PATH_REGEX = /^\/share\/[^/]+\/?$/;
const SHARED_MESSAGES_PATH_REGEX = /^\/api\/share\/[^/]+$/;
const SHARE_FORK_PATH_REGEX = /^\/api\/share\/[^/]+\/fork$/;

const normalizePathname = (pathname: string) =>
  pathname.startsWith('/') ? pathname : `/${pathname}`;

const stripBasePath = (pathname: string) => {
  const normalizedPathname = normalizePathname(pathname);
  const baseUrl = endpoints.apiBaseUrl();
  if (!baseUrl) {
    return normalizedPathname;
  }

  const normalizedBaseUrl = normalizePathname(baseUrl);
  if (
    normalizedPathname === normalizedBaseUrl ||
    normalizedPathname.startsWith(`${normalizedBaseUrl}/`)
  ) {
    return normalizedPathname.slice(normalizedBaseUrl.length) || '/';
  }
  return normalizedPathname;
};

const isSharePage = () => SHARE_PAGE_PATH_REGEX.test(stripBasePath(window.location.pathname));

const getRequestPathname = (url?: string) => {
  if (typeof url !== 'string') {
    return '';
  }
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? '';
  }
};

const isSharedMessagesRequest = (url?: string, method?: string) =>
  method?.toLowerCase() === 'get' &&
  SHARED_MESSAGES_PATH_REGEX.test(stripBasePath(getRequestPathname(url)));

/** The "continue this chat" fork is a deliberate authenticated action initiated
 *  from a share page, so it must reach auth recovery/redirect like the shared
 *  data request — otherwise a logged-out (or cold-loaded) viewer's 401 is
 *  rejected silently instead of routing them through login. */
const isShareForkRequest = (url?: string, method?: string) =>
  method?.toLowerCase() === 'post' &&
  SHARE_FORK_PATH_REGEX.test(stripBasePath(getRequestPathname(url)));

const dispatchTokenUpdatedEvent = (token: string) => {
  setTokenHeader(token);
  clearAuthRedirectStartedAt();
  window.dispatchEvent(new CustomEvent('tokenUpdated', { detail: token }));
};

const getAuthRecoveryState = (): AuthRecoveryState => {
  const browserWindow = window as AuthRecoveryWindow;
  browserWindow.__librechatAuthRecovery ??= {
    lastRedirectStartedAt: 0,
    refreshPromise: null,
    generation: 0,
  };
  return browserWindow.__librechatAuthRecovery;
};

const getAuthGeneration = (): number => getAuthRecoveryState().generation;

const advanceAuthGeneration = (): number => {
  const state = getAuthRecoveryState();
  state.generation += 1;
  /** A promise started under the old generation would resolve null and read as denial. */
  state.refreshPromise = null;
  return state.generation;
};

const dispatchAuthUnavailableEvent = () => {
  window.dispatchEvent(new CustomEvent(AUTH_UNAVAILABLE_EVENT));
};

const getAuthRedirectStartedAt = () => {
  const state = getAuthRecoveryState();
  try {
    const startedAt = window.localStorage.getItem(AUTH_REDIRECT_STORAGE_KEY);
    const storedStartedAt = startedAt != null ? Number(startedAt) : 0;
    const finiteStartedAt = Number.isFinite(storedStartedAt) ? storedStartedAt : 0;
    return Math.max(finiteStartedAt, state.lastRedirectStartedAt);
  } catch {
    return state.lastRedirectStartedAt;
  }
};

const setAuthRedirectStartedAt = () => {
  const state = getAuthRecoveryState();
  state.lastRedirectStartedAt = Date.now();
  try {
    window.localStorage.setItem(AUTH_REDIRECT_STORAGE_KEY, String(state.lastRedirectStartedAt));
  } catch {
    // localStorage can be blocked in embedded/private contexts.
  }
};

const clearAuthRedirectStartedAt = () => {
  const state = getAuthRecoveryState();
  state.lastRedirectStartedAt = 0;
  try {
    window.localStorage.removeItem(AUTH_REDIRECT_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
};

const isAuthRedirectInProgress = () => {
  const startedAt = getAuthRedirectStartedAt();
  return (
    Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < AUTH_REDIRECT_DEDUPE_MS
  );
};

/** Stream transports surface the body as text, while axios and fetch have already parsed it. */
const parseSetupPayload = (payload: unknown): unknown => {
  if (typeof payload !== 'string') {
    return payload;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
};

const getTwoFactorSetupToken = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload == null) {
    return null;
  }

  const response = payload as {
    code?: unknown;
    twoFASetupRequired?: unknown;
    tempToken?: unknown;
  };
  if (
    response.code !== TWO_FACTOR_ENROLLMENT_REQUIRED_CODE ||
    response.twoFASetupRequired !== true ||
    typeof response.tempToken !== 'string' ||
    !response.tempToken.trim()
  ) {
    return null;
  }

  return response.tempToken.trim();
};

/**
 * The setup token and the bearer it replaces are both tab-scoped, so a hand-off another tab
 * started does nothing for this one: once the bearer is dropped, 401s skip recovery and the tab
 * would stay on the app until reloaded. Only this tab's own navigation dedupes the hand-off.
 */
const isTabRedirectInProgress = () => {
  const startedAt = getAuthRecoveryState().lastRedirectStartedAt;
  return startedAt > 0 && Date.now() - startedAt < AUTH_REDIRECT_DEDUPE_MS;
};

const redirectToTwoFactorSetupOnce = (tempToken: string) => {
  const isDurable = persistTwoFactorSetupToken(tempToken);
  setTokenHeader(undefined);
  if (isTabRedirectInProgress()) {
    return;
  }

  const loginRedirect = endpoints.buildLoginRedirectUrl();
  const redirectTo = new URL(loginRedirect, window.location.origin).searchParams.get('redirect_to');
  const searchParams = new URLSearchParams();
  if (redirectTo) {
    searchParams.set('redirect_to', redirectTo);
  }
  const query = searchParams.toString();

  const href = `${endpoints.apiBaseUrl()}/login/2fa/setup${query ? `?${query}` : ''}`;
  setAuthRedirectStartedAt();
  window.dispatchEvent(
    new CustomEvent(AUTH_REDIRECT_EVENT, { detail: { href, inDocument: !isDurable } }),
  );
  if (isDurable) {
    window.location.href = href;
    return;
  }

  /**
   * Session storage refused the token, so only the in-memory mirror holds it and replacing the
   * document would throw it away, stranding the setup screen on its expired state. Move the router
   * instead: the history entry is the same one the hard navigation would have produced, and the
   * router picks it up either from this event or, if it has yet to mount, from the location.
   *
   * The document surviving is also why the event above reports the hand-off as in-document: the
   * session this redirect replaces would otherwise live on in whatever state the app already
   * holds, which a replaced document would have discarded.
   */
  window.history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

const dispatchAuthRecoveryEvent = (state: 'started' | 'finished') => {
  window.dispatchEvent(new CustomEvent(AUTH_RECOVERY_EVENT, { detail: { state } }));
};

const setRequestAuthorizationHeader = (config: AxiosRequestConfig, token: string) => {
  const headers = (config.headers ?? {}) as Record<string, string>;
  headers['Authorization'] = `Bearer ${token}`;
  config.headers = headers;
};

const isAuthRecoveryEndpoint = (url?: string) =>
  url?.includes('/api/auth/2fa') === true ||
  url?.includes('/api/auth/logout') === true ||
  url?.includes('/api/auth/refresh') === true;

const startAuthRecovery = (retryRefresh?: boolean) => {
  const state = getAuthRecoveryState();
  if (state.refreshPromise) {
    return state.refreshPromise;
  }

  const requestGeneration = state.generation;
  dispatchAuthRecoveryEvent('started');
  const refreshPromise: Promise<string | null> = refreshToken(retryRefresh, {
    _managedRefresh: true,
  })
    .then((response) => {
      if (state.generation !== requestGeneration) {
        return null;
      }
      const setupToken = getTwoFactorSetupToken(response);
      if (setupToken) {
        redirectToTwoFactorSetupOnce(setupToken);
        return null;
      }
      const token = response?.token ?? '';
      if (!token) {
        return null;
      }
      dispatchTokenUpdatedEvent(token);
      return token;
    })
    .finally(() => {
      /** An older flight settling after a newer one has started must not erase the newer
       *  flight's promise, or a request arriving after it would start a redundant third. */
      if (state.refreshPromise === refreshPromise) {
        state.refreshPromise = null;
      }
      dispatchAuthRecoveryEvent('finished');
    });

  state.refreshPromise = refreshPromise;
  return refreshPromise;
};

const redirectToLoginOnce = () => {
  if (isAuthRedirectInProgress()) {
    return;
  }

  const href = endpoints.apiBaseUrl() + endpoints.buildLoginRedirectUrl();
  setAuthRedirectStartedAt();
  window.dispatchEvent(
    new CustomEvent(AUTH_REDIRECT_EVENT, { detail: { href, inDocument: false } }),
  );
  window.location.href = href;
};

const parseBearerToken = (authorization: unknown) => {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return null;
  }
  return authorization.slice('Bearer '.length);
};

const getBearerToken = () => parseBearerToken(axios.defaults.headers.common['Authorization']);

const getRequestBearerToken = ({ headers }: AxiosRequestConfig) =>
  parseBearerToken(
    headers instanceof AxiosHeaders ? headers.get('Authorization') : headers?.['Authorization'],
  );

/**
 * A request dispatched before a refresh settled can be answered after it. That 401 describes the
 * bearer the request carried, not the one now in use, so the request is replayed with the current
 * bearer instead of starting a second refresh for a session that has already recovered.
 */
const getSupersedingToken = (sentToken: string | null) => {
  if (!sentToken || getAuthRecoveryState().refreshPromise) {
    return null;
  }
  const currentToken = getBearerToken();
  return currentToken && currentToken !== sentToken ? currentToken : null;
};

const getJwtExpiryMs = (token: string) => {
  const payload = token.split('.')[1];
  if (!payload) {
    return null;
  }

  try {
    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
      '=',
    );
    const decodedPayload = JSON.parse(window.atob(paddedPayload)) as { exp?: number };
    return typeof decodedPayload.exp === 'number' ? decodedPayload.exp * 1000 : null;
  } catch {
    return null;
  }
};

const shouldRefreshBeforeRequest = (url?: string) => {
  if (isAuthRecoveryEndpoint(url) || isAuthRedirectInProgress()) {
    return false;
  }

  const token = getBearerToken();
  if (!token) {
    return false;
  }

  const expiresAt = getJwtExpiryMs(token);
  if (expiresAt == null) {
    return false;
  }

  const timeUntilExpiry = expiresAt - Date.now();
  return timeUntilExpiry > 0 && timeUntilExpiry <= TOKEN_REFRESH_BUFFER_MS;
};

/** Thrown when a proactive renewal is definitively denied, so the request interceptor and
 *  `_authenticatedFetch` reject the pending request instead of sending it with the bearer the
 *  denial just invalidated. It carries no `response`, so the axios response interceptor's
 *  reactive 401 handler — which only acts once `error.response` exists — rejects it unchanged
 *  without starting a second refresh or redirect. */
class AuthSessionEndedError extends Error {
  readonly code = 'AUTH_SESSION_ENDED';
  constructor() {
    super('Auth session ended');
    this.name = 'AuthSessionEndedError';
  }
}

/** Mirrors the reactive 401 path's handling of a rejected refresh for the proactive path, which
 *  has no failed request of its own to reject: a 503 AUTH_SESSION_CHECK_UNAVAILABLE still
 *  surfaces the event, and a network error or timeout keeps the old token, since neither says
 *  the session has ended. Every other denial throws `AuthSessionEndedError` so the pending
 *  request is never sent with the invalidated bearer — whether or not the generation still
 *  matches, since a request that only joined the denied flight must be denied too — unless a
 *  newer login already replaced that bearer, in which case the request continues with the new
 *  token instead. advanceAuthGeneration()/redirectToLoginOnce() stay guarded by the generation
 *  check so only the flight that first discovers the denial redirects. */
const handleProactiveRefreshFailure = (
  error: unknown,
  requestGeneration: number,
  tokenAtStart: string | null,
): string | null => {
  const generationMatches = getAuthGeneration() === requestGeneration;
  const classification = classifyProactiveRefreshFailure(error);

  if (classification === 'unavailable') {
    if (generationMatches) {
      dispatchAuthUnavailableEvent();
    }
    return null;
  }
  if (classification === 'network') {
    return null;
  }

  const currentToken = getBearerToken();
  if (currentToken && currentToken !== tokenAtStart) {
    return currentToken;
  }

  if (generationMatches) {
    advanceAuthGeneration();
    redirectToLoginOnce();
  }
  throw new AuthSessionEndedError();
};

const refreshBeforeRequest = async (url?: string) => {
  const state = getAuthRecoveryState();
  const tokenAtStart = getBearerToken();
  if (state.refreshPromise && !isAuthRecoveryEndpoint(url)) {
    const requestGeneration = getAuthGeneration();
    return state.refreshPromise.catch((error) =>
      handleProactiveRefreshFailure(error, requestGeneration, tokenAtStart),
    );
  }

  if (!shouldRefreshBeforeRequest(url)) {
    return null;
  }

  const requestGeneration = getAuthGeneration();
  return startAuthRecovery(false).catch((error) =>
    handleProactiveRefreshFailure(error, requestGeneration, tokenAtStart),
  );
};

const withAuthorization = (options: RequestInit | undefined, token: string | null): RequestInit => {
  const headers = new Headers(options?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { ...options, headers };
};

/**
 * Enforcement reaches the SSE hooks as an error event rather than a `Response`, because the stream
 * transport is a raw `XMLHttpRequest` with neither the axios interceptor nor `_authenticatedFetch`
 * in front of it. They hand the event body here so an enrollment 403 opens setup instead of being
 * reported as a generic transport failure and retried against a condition that cannot clear.
 */
const redirectIfTwoFactorSetupPayload = (payload: unknown): boolean => {
  const setupToken = getTwoFactorSetupToken(parseSetupPayload(payload));
  if (!setupToken) {
    return false;
  }

  redirectToTwoFactorSetupOnce(setupToken);
  return true;
};

const redirectIfTwoFactorSetupRequired = async (response: Response): Promise<boolean> => {
  if (response.status !== 403) {
    return false;
  }

  return redirectIfTwoFactorSetupPayload(
    await response
      .clone()
      .json()
      .catch(() => null),
  );
};

const needsAuthRecovery = (response: Response, url: string) =>
  response.status === 401 &&
  !isAuthRecoveryEndpoint(url) &&
  !isAuthRedirectInProgress() &&
  getBearerToken() != null;

async function _authenticatedFetch(url: string, options?: RequestInit): Promise<Response> {
  if (typeof window === 'undefined') {
    return fetch(url, options);
  }

  const token = (await refreshBeforeRequest(url)) ?? getBearerToken();
  let response = await fetch(url, withAuthorization(options, token));
  if ((await redirectIfTwoFactorSetupRequired(response)) || !needsAuthRecovery(response, url)) {
    return response;
  }

  const supersedingToken = getSupersedingToken(token);
  if (supersedingToken) {
    await response.body?.cancel().catch(() => undefined);
    response = await fetch(url, withAuthorization(options, supersedingToken));
    if ((await redirectIfTwoFactorSetupRequired(response)) || !needsAuthRecovery(response, url)) {
      return response;
    }
  }

  const requestGeneration = getAuthGeneration();
  let refreshedToken: string | null;
  try {
    refreshedToken = await startAuthRecovery(false);
  } catch (refreshError) {
    if (getAuthGeneration() !== requestGeneration) {
      return response;
    }
    if (classifyRefreshFailure(refreshError) === 'unavailable') {
      dispatchAuthUnavailableEvent();
      return markAuthSessionUnavailable(response);
    }
    advanceAuthGeneration();
    redirectToLoginOnce();
    return response;
  }

  if (getAuthGeneration() !== requestGeneration) {
    return response;
  }

  if (!refreshedToken) {
    advanceAuthGeneration();
    redirectToLoginOnce();
    return response;
  }

  await response.body?.cancel().catch(() => undefined);
  const retriedResponse = await fetch(url, withAuthorization(options, refreshedToken));
  await redirectIfTwoFactorSetupRequired(retriedResponse);
  return retriedResponse;
}

if (typeof window !== 'undefined') {
  /** Auth is a bearer token and no route reads an XSRF header. Axios 1.21+ otherwise awaits
   *  `cookieStore.get` before every same-origin send, and a browser whose cookie store never
   *  answers then strands every request behind it. */
  axios.defaults.withXSRFToken = false;

  axios.interceptors.request.use(async (config) => {
    const token = await refreshBeforeRequest(config.url);
    if (token) {
      setRequestAuthorizationHeader(config, token);
    }
    return config;
  });

  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config as RetryableAxiosRequestConfig | undefined;
      if (!error.response) {
        return Promise.reject(error);
      }
      if (!originalRequest) {
        return Promise.reject(error);
      }

      if (error.response.status === 403) {
        const setupToken = getTwoFactorSetupToken(error.response.data);
        if (setupToken) {
          redirectToTwoFactorSetupOnce(setupToken);
          return Promise.reject(error);
        }
      }

      const isRefreshRequest = originalRequest.url?.includes('/api/auth/refresh') === true;
      if (isAuthRecoveryEndpoint(originalRequest.url) && !isRefreshRequest) {
        return Promise.reject(error);
      }

      /** A managed refresh's own failure is already awaited by its caller; retrying it here
       *  would loop, since a superseded generation has already cleared refreshPromise. */
      if (isRefreshRequest && originalRequest._managedRefresh) {
        return Promise.reject(error);
      }

      /** Skip refresh when the Authorization header has been cleared (e.g. during logout),
       *  but allow the shared link data request to proceed so private shares can still
       *  recover auth/redirect without unrelated share-page queries forcing login. */
      if (
        !axios.defaults.headers.common['Authorization'] &&
        !(
          isSharePage() &&
          (isSharedMessagesRequest(originalRequest.url, originalRequest.method) ||
            isShareForkRequest(originalRequest.url, originalRequest.method))
        )
      ) {
        return Promise.reject(error);
      }

      if (isAuthRedirectInProgress()) {
        return Promise.reject(error);
      }

      if (error.response.status === 401 && !originalRequest._retry) {
        const supersedingToken = isRefreshRequest
          ? null
          : getSupersedingToken(getRequestBearerToken(originalRequest));
        if (supersedingToken) {
          setRequestAuthorizationHeader(originalRequest, supersedingToken);
          return axios(originalRequest);
        }

        const hasActiveRecovery = getAuthRecoveryState().refreshPromise != null;
        if (!hasActiveRecovery) {
          console.warn('401 error, refreshing token');
        }
        originalRequest._retry = true;
        const requestGeneration = getAuthGeneration();

        try {
          const token = await startAuthRecovery(
            // Handle edge case where we get a blank screen if the initial 401 error is from a refresh token request
            isRefreshRequest,
          );

          if (getAuthGeneration() !== requestGeneration) {
            return Promise.reject(error);
          }

          if (token) {
            setRequestAuthorizationHeader(originalRequest, token);
            return await axios(originalRequest);
          }

          advanceAuthGeneration();
          redirectToLoginOnce();
          return Promise.reject(error);
        } catch (refreshError) {
          if (getAuthGeneration() !== requestGeneration) {
            return Promise.reject(error);
          }

          if (classifyRefreshFailure(refreshError) === 'unavailable') {
            dispatchAuthUnavailableEvent();
            return Promise.reject(markAuthSessionUnavailable(error));
          }

          /** A rejected refresh must route to login like an empty token, or the 401 reaches the caller unredirected. */
          advanceAuthGeneration();
          redirectToLoginOnce();
          return Promise.reject(error);
        }
      }

      return Promise.reject(error);
    },
  );
}

export default {
  get: _get,
  getResponse: _getResponse,
  post: _post,
  postMultiPart: _postMultiPart,
  postTTS: _postTTS,
  put: _put,
  delete: _delete,
  deleteWithOptions: _deleteWithOptions,
  patch: _patch,
  authenticatedFetch: _authenticatedFetch,
  refreshToken,
  dispatchTokenUpdatedEvent,
  redirectIfTwoFactorSetupPayload,
  classifyRefreshFailure,
  isAuthSessionUnavailableError,
  getAuthGeneration,
  advanceAuthGeneration,
};
