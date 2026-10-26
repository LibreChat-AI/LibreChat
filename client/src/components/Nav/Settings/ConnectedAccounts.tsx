import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, Gitlab } from 'lucide-react';
import { apiBaseUrl } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Chip,
  GithubIcon,
  Skeleton,
  Spinner,
} from '@librechat/client';
import type { PullRequestProvider } from 'librechat-data-provider';
import type { ComponentType } from 'react';
import type { TranslationKeys } from '~/hooks';
import {
  useGetStartupConfig,
  usePullRequestConnectionQuery,
  useConnectPullRequestAccountMutation,
  useDisconnectPullRequestAccountMutation,
  watchPullRequestSignIn,
  pullRequestSignInSession,
} from '~/data-provider';
import { useLocalize } from '~/hooks';

const PROVIDERS: Record<
  PullRequestProvider,
  { Icon: ComponentType<{ className?: string }>; name: TranslationKeys }
> = {
  github: { Icon: GithubIcon, name: 'com_ui_pr_provider_github' },
  gitlab: { Icon: Gitlab, name: 'com_ui_pr_provider_gitlab' },
  bitbucket: { Icon: ExternalLink, name: 'com_ui_pr_provider_bitbucket' },
};

/** A grant whose app the server no longer has, so no provider is named for it. */
const UNNAMED_PROVIDER: (typeof PROVIDERS)[PullRequestProvider] = {
  Icon: ExternalLink,
  name: 'com_ui_settings_label_pull_request_account',
};

type ConnectError = 'com_ui_pr_account_connect_error' | 'com_ui_pr_account_popup_blocked';

/** How long a started sign-in is watched for when the server does not say how long it lasts. */
const DEFAULT_CONNECT_FLOW_SECONDS = 10 * 60;

/**
 * The user's own account for pull request lookups. One row for the provider the operator
 * configured: the status, and a single action to connect or disconnect it. The action button is
 * swapped as the state changes, so focus is carried over to whichever button replaces it.
 */
export default function ConnectedAccounts() {
  const localize = useLocalize();
  const rowId = useId();
  const { data: startupConfig } = useGetStartupConfig();
  const queryClient = useQueryClient();
  const status = usePullRequestConnectionQuery();
  const connectMutation = useConnectPullRequestAccountMutation();
  const disconnectMutation = useDisconnectPullRequestAccountMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [connectError, setConnectError] = useState<ConnectError | null>(null);
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const groupRef = useRef<HTMLDivElement | null>(null);
  /** Where focus goes when a disconnect removes the row along with its trigger. */
  const fallbackRef = useRef<HTMLElement | null>(null);
  const keepFocus = useRef(false);
  /** Whether the row is still shown, so a failure after Settings closed is reported elsewhere. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      /** A status that hides the row while a handoff is armed takes the focused button with it. */
      if (keepFocus.current) {
        const fallback = fallbackRef.current;
        setTimeout(() => {
          if (document.activeElement == null || document.activeElement === document.body) {
            fallback?.focus();
          }
        }, 0);
      }
    };
  }, []);

  /**
   * Callback ref, so a replacement button takes focus as it mounts after an action, but only
   * when the button it replaced took focus away with it.
   */
  const bindAction = useCallback((button: HTMLButtonElement | null) => {
    actionRef.current = button;
    if (button == null || !keepFocus.current) {
      return;
    }
    keepFocus.current = false;
    if (document.activeElement == null || document.activeElement === document.body) {
      button.focus();
    }
  }, []);

  /** A disconnect that failed may still have ended the connection: once the status read after it
   *  says so, the confirmation closes as on success, and focus moves on the same way. */
  const disconnected = status.data?.connected === false;
  useEffect(() => {
    if (!confirmOpen || !disconnectFailed || !disconnected) {
      return;
    }
    keepFocus.current = true;
    setConfirmOpen(false);
    setDisconnectFailed(false);
  }, [confirmOpen, disconnectFailed, disconnected]);

  /**
   * The server is the authority: an app it no longer has is nothing to connect to, and once the
   * status loads its provider is the one a connection goes to, whatever the cached startup says.
   * A grant still stored stays removable after the app is turned off, or turning it back on would
   * revive it.
   */
  const revocable = status.data?.connected === true;
  /** A grant whose app is turned off: kept until removed, but no lookup uses it. */
  const unused = revocable && status.data?.configured === false;
  /** The startup config only until the status loads: after that a grant whose app is gone may
   *  belong to any provider, so the row names it only as an account. */
  const provider = status.data != null ? status.data.provider : startupConfig?.pullRequestsConnect;
  if (!revocable && (provider == null || status.data?.configured === false)) {
    return null;
  }

  const { Icon, name: nameKey } = provider != null ? PROVIDERS[provider] : UNNAMED_PROVIDER;
  const name = localize(nameKey);
  const labelId = `${rowId}-label`;
  const descriptionId = `${rowId}-description`;

  const connect = () => {
    if (connectMutation.isLoading) {
      return;
    }
    setConnectError(null);
    /** Opened inside the click so the browser treats it as user initiated. */
    const popup = window.open('', '_blank');
    if (popup == null) {
      setConnectError('com_ui_pr_account_popup_blocked');
      return;
    }
    popup.opener = null;
    /**
     * The promise, not `mutate` callbacks, so the window opened in the click is still sent to the
     * sign-in page (or closed) when Settings is closed before the server answers. The watch on the
     * sign-in lives outside this row for the same reason.
     */
    const startedIn = pullRequestSignInSession();
    connectMutation.mutateAsync().then(
      ({ url, expiresInSeconds, flowId }) => {
        /** Signed out meanwhile: the sign-in belongs to a session that is over. */
        if (startedIn !== pullRequestSignInSession()) {
          popup.close();
          return;
        }
        /**
         * Closed while the server answered: the user cancelled, and nothing will sign in. Still the
         * blank page this window opened, so unlike after navigating, `closed` can be trusted here.
         */
        if (popup.closed) {
          return;
        }
        popup.location.href = url;
        keepFocus.current = true;
        watchPullRequestSignIn(queryClient, {
          startedIn,
          flowId,
          expiresAt: Date.now() + (expiresInSeconds ?? DEFAULT_CONNECT_FLOW_SECONDS) * 1000,
        });
      },
      () => {
        /** With Settings closed the row cannot explain the failure, so the window it opened does,
         *  on the sign-in error page. */
        if (!mounted.current) {
          popup.location.href = `${apiBaseUrl()}/oauth/error?error=connect_failed`;
          return;
        }
        popup.close();
        setConnectError('com_ui_pr_account_connect_error');
      },
    );
  };

  const disconnect = () => {
    setDisconnectFailed(false);
    /** Taken before the request: removing a grant whose app is off removes this row too. */
    fallbackRef.current =
      groupRef.current?.closest<HTMLElement>('[role="tabpanel"], [role="dialog"]') ?? null;
    disconnectMutation.mutate(undefined, {
      onSuccess: () => {
        keepFocus.current = true;
        setConfirmOpen(false);
      },
      onError: () => setDisconnectFailed(true),
    });
  };

  const retry = () => {
    keepFocus.current = true;
    /** Taken before the request: an answer that the app is gone hides this row, Retry with it. */
    const fallback = groupRef.current?.closest<HTMLElement>('[role="tabpanel"], [role="dialog"]');
    status.refetch().then((result) => {
      if (result.isError) {
        keepFocus.current = false;
      }
      /** After React has applied the answer: focus left on nothing goes to the panel. */
      setTimeout(() => {
        const lost = document.activeElement == null || document.activeElement === document.body;
        if (groupRef.current == null && lost) {
          fallback?.focus();
        }
      }, 0);
    });
  };

  let statusContent = <Chip tone="neutral">{localize('com_ui_pr_account_checking')}</Chip>;
  let action = <Skeleton className="h-9 w-24" aria-hidden="true" />;

  const statusError = (
    <span className="text-text-destructive text-xs">
      {localize('com_ui_pr_account_status_error')}
    </span>
  );

  /** A grant known to be removable stays removable while a later status check fails. */
  if (status.isError && !revocable) {
    statusContent = statusError;
    action = (
      <Button
        ref={bindAction}
        type="button"
        variant="outline"
        size="sm"
        aria-label={localize('com_ui_retry')}
        aria-busy={status.isFetching}
        onClick={retry}
      >
        {status.isFetching ? <Spinner className="h-4 w-4" /> : localize('com_ui_retry')}
      </Button>
    );
  } else if (status.data?.connected === true) {
    statusContent = unused ? (
      <Chip tone="neutral">{localize('com_ui_pr_account_not_in_use')}</Chip>
    ) : (
      <Chip tone="success">{localize('com_ui_pr_account_connected')}</Chip>
    );
    action = (
      <AlertDialogTrigger asChild>
        <Button
          ref={bindAction}
          type="button"
          variant="outline"
          size="sm"
          aria-label={localize('com_ui_pr_account_disconnect_aria', { 0: name })}
        >
          {localize('com_ui_pr_account_disconnect')}
        </Button>
      </AlertDialogTrigger>
    );
  } else if (status.data != null) {
    statusContent = <Chip tone="neutral">{localize('com_ui_pr_account_not_connected')}</Chip>;
    action = (
      <Button
        ref={bindAction}
        type="button"
        variant="outline"
        size="sm"
        aria-label={localize('com_ui_pr_account_connect_aria', { 0: name })}
        aria-busy={connectMutation.isLoading}
        aria-disabled={connectMutation.isLoading}
        onClick={connect}
      >
        {connectMutation.isLoading ? (
          <Spinner className="h-4 w-4" />
        ) : (
          localize('com_ui_pr_account_connect')
        )}
      </Button>
    );
  }

  if (status.isError && revocable) {
    statusContent = statusError;
  }

  return (
    <AlertDialog
      open={confirmOpen}
      onOpenChange={(open) => {
        /** A disconnect already sent cannot be taken back, so it is not dismissed mid-request. */
        if (!open && disconnectMutation.isLoading) {
          return;
        }
        /** Dismissed after a failed disconnect whose status read is still out: that read may
         *  replace or hide the trigger focus returns to, so the handoff stays armed. */
        if (!open && disconnectFailed) {
          keepFocus.current = true;
        }
        setConfirmOpen(open);
        setDisconnectFailed(false);
      }}
    >
      <div
        ref={groupRef}
        role="group"
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center gap-3">
          <span className="text-text-secondary shrink-0" aria-hidden="true">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            {/** The status sits beside the name, not in the row, so the description keeps the
             *  column's width on a phone. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p id={labelId} className="text-text-primary text-sm font-medium">
                {name}
              </p>
              <div role="status">{statusContent}</div>
            </div>
            <p id={descriptionId} className="text-text-secondary text-xs">
              {localize(
                unused ? 'com_ui_pr_account_unused_description' : 'com_ui_pr_account_description',
              )}
            </p>
          </div>
          <div className="shrink-0">{action}</div>
        </div>
        {connectError != null && (
          <p role="alert" className="text-text-destructive text-xs">
            {localize(connectError)}
          </p>
        )}
      </div>

      <AlertDialogContent
        className="w-11/12 max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const action = actionRef.current;
          if (action?.isConnected === true) {
            action.focus();
          } else {
            fallbackRef.current?.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {localize('com_ui_pr_account_disconnect_title', { 0: name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {localize('com_ui_pr_account_disconnect_description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {disconnectFailed && (
          <p role="alert" className="text-text-destructive text-xs">
            {localize('com_ui_pr_account_disconnect_error')}
          </p>
        )}
        <AlertDialogFooter className="mt-2">
          <AlertDialogCancel asChild>
            <Button type="button" variant="outline" disabled={disconnectMutation.isLoading}>
              {localize('com_ui_cancel')}
            </Button>
          </AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            aria-label={localize('com_ui_pr_account_disconnect')}
            aria-busy={disconnectMutation.isLoading}
            disabled={disconnectMutation.isLoading}
            onClick={disconnect}
          >
            {disconnectMutation.isLoading ? (
              <Spinner className="h-4 w-4" />
            ) : (
              localize('com_ui_pr_account_disconnect')
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
