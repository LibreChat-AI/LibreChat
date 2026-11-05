import { useEffect, useRef } from 'react';
import { useSetRecoilState } from 'recoil';
import { Button, Spinner } from '@librechat/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys, setTokenHeader } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { createOpenIDDocumentCheck } from '~/hooks/Auth/openidCheck';
import { endSessionClientState } from '~/hooks/AuthContext';
import { useGetStartupConfig } from '~/data-provider';
import { persistRedirectToSession } from '~/utils';
import { useLocalize } from '~/hooks';
import store from '~/store';

const documentCheck = createOpenIDDocumentCheck({
  start: dataService.startOpenIDSessionCheck,
  complete: dataService.completeOpenIDSessionCheck,
  currentUrl: () => new URL(window.location.href),
  replaceUrl: (url) => window.history.replaceState(window.history.state, '', url),
});

/** AuthContext and private queries do not mount until the browser identity is checked. */
export default function OpenIDSessionGate({ children }: { children: ReactNode }) {
  const config = useGetStartupConfig();
  const localize = useLocalize();
  const released = useRef(false);
  const cleared = useRef(false);
  const queryClient = useQueryClient();
  const setUser = useSetRecoilState(store.user);
  const check = useMutation([MutationKeys.openidSessionCheck], {
    mutationFn: (retry: boolean) => (retry ? documentCheck.retry() : documentCheck.run()),
  });
  const status = check.data?.status;
  const { mutate } = check;

  useEffect(() => {
    if (!config.data || released.current) return;
    if (config.data.openidSessionCheckEnabled !== true) return;
    if ((document as Document & { prerendering?: boolean }).prerendering) {
      const activate = () => {
        mutate(false);
      };
      document.addEventListener('prerenderingchange', activate, { once: true });
      return () => document.removeEventListener('prerenderingchange', activate);
    }
    mutate(false);
  }, [config.data, mutate]);

  useEffect(() => {
    if (check.data?.status === 'redirect') {
      persistRedirectToSession(
        window.location.pathname + window.location.search + window.location.hash,
      );
      window.location.assign(check.data.authorizationUrl);
    }
    if (status !== 'login_required' || cleared.current) return;
    cleared.current = true;
    setTokenHeader('');
    setUser(undefined);
    endSessionClientState();
    void queryClient.cancelQueries({
      predicate: (query) => query.queryKey[0] !== QueryKeys.startupConfig,
    });
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== QueryKeys.startupConfig,
    });
  }, [check.data, status, queryClient, setUser]);

  if (
    released.current ||
    (config.data && config.data.openidSessionCheckEnabled !== true) ||
    status === 'verified' ||
    status === 'not_required'
  ) {
    released.current = true;
    return <>{children}</>;
  }
  const needsLogin = status === 'login_required' || status === 'interaction_required';
  const unavailable = config.isError || status === 'unavailable' || check.isError;
  const pendingMessage = unavailable
    ? 'com_auth_session_check_unavailable'
    : 'com_auth_session_check_loading';
  const message = needsLogin ? 'com_auth_session_check_required' : pendingMessage;
  const continueLogin = () => {
    persistRedirectToSession(
      window.location.pathname + window.location.search + window.location.hash,
    );
    window.location.assign(`${config.data!.serverDomain.replace(/\/$/, '')}/oauth/openid`);
  };
  return (
    <main className="bg-surface-primary text-text-primary flex min-h-screen items-center justify-center">
      <div
        className="flex max-w-md flex-col items-center gap-4 p-6"
        role="status"
        aria-live="polite"
      >
        {!needsLogin && !unavailable && <Spinner />}
        <p>{localize(message)}</p>
        {needsLogin && (
          <Button onClick={continueLogin}>{localize('com_auth_session_check_continue')}</Button>
        )}
        {unavailable && (
          <Button
            onClick={() => {
              if (config.isError) void config.refetch();
              else check.mutate(true);
            }}
          >
            {localize('com_ui_retry')}
          </Button>
        )}
      </div>
    </main>
  );
}
