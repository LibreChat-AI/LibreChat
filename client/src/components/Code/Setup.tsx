import { useEffect, useState } from 'react';
import { buildLoginRedirectUrl } from 'librechat-data-provider';
import { Alert, Button, Label, Spinner } from '@librechat/client';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import type { CodeSetupStatus } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks';
import { useCodeSetupAttemptQuery, useCodeSetupDecisionMutation } from '~/data-provider/CodeSetup';
import TermsAndConditionsModal from '~/components/ui/TermsAndConditionsModal';
import { useUserTermsQuery, useGetStartupConfig } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { getResponseStatus } from '~/utils/errors';
import { useLocalize } from '~/hooks';

const statusKeys: Record<CodeSetupStatus, TranslationKeys> = {
  pending: 'com_ui_code_setup_pending',
  provisioning: 'com_ui_code_setup_provisioning',
  approved: 'com_ui_code_setup_approved',
  completed: 'com_ui_code_setup_completed',
  denied: 'com_ui_code_setup_denied',
  cancelled: 'com_ui_code_setup_cancelled',
  expired: 'com_ui_code_setup_expired',
  failed: 'com_ui_code_setup_failed',
};

function Loading() {
  const localize = useLocalize();
  return (
    <div role="status" className="flex items-center gap-2">
      <Spinner className="size-5" aria-hidden="true" />
      {localize('com_ui_code_setup_loading')}
    </div>
  );
}

function Page({ children }: { children: ReactNode }) {
  const localize = useLocalize();
  return (
    <main className="bg-surface-primary text-text-primary min-h-dvh px-4 py-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{localize('com_ui_code_setup_title')}</h1>
        {children}
      </div>
    </main>
  );
}

function Review({ attemptId, userId }: { attemptId: string; userId: string }) {
  const localize = useLocalize();
  const { logout } = useAuthContext();
  const [controlPlaneId, setControlPlaneId] = useState('');
  const [deadlinePassed, setDeadlinePassed] = useState(false);
  const configQuery = useGetStartupConfig();
  const termsConfig = configQuery.data?.interface?.termsOfService;
  const requiresTerms = termsConfig?.modalAcceptance === true;
  const termsQuery = useUserTermsQuery({ enabled: requiresTerms });
  const termsReady =
    configQuery.isSuccess &&
    (!requiresTerms ||
      (termsQuery.isSuccess && !termsQuery.isFetching && termsQuery.data.termsAccepted));
  const query = useCodeSetupAttemptQuery(attemptId, userId, termsReady);
  const { refetch } = query;
  const approve = useCodeSetupDecisionMutation(attemptId, userId, 'approve');
  const deny = useCodeSetupDecisionMutation(attemptId, userId, 'deny');
  const attempt = query.data;
  const expiresAt = attempt?.expiresAt;

  useEffect(() => {
    if (expiresAt == null) {
      return;
    }
    const remaining = Date.parse(expiresAt) - Date.now();
    setDeadlinePassed(remaining <= 0);
    if (remaining <= 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const checkDeadline = () => {
      const remaining = Date.parse(expiresAt) - Date.now();
      if (remaining > 0) {
        timer = setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647));
        return;
      }
      setDeadlinePassed(true);
      void refetch();
    };
    timer = setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expiresAt, refetch]);

  const isDeciding = approve.isLoading || deny.isLoading;
  const canDecide =
    attempt?.status === 'pending' ||
    (attempt?.status === 'failed' && attempt.failure?.retryable === true);
  const expired =
    canDecide && (deadlinePassed || (expiresAt != null && Date.parse(expiresAt) <= Date.now()));
  const status = expired ? 'expired' : attempt?.status;
  const selectedPlaneExists = attempt?.controlPlanes.some((plane) => plane.id === controlPlaneId);
  const mutationError = approve.error ?? deny.error;
  const unavailable = [400, 403, 404, 410].includes(getResponseStatus(query.error) ?? 0);
  const mutationUnavailable = [400, 403, 404, 410].includes(getResponseStatus(mutationError) ?? 0);

  let content: ReactNode;
  if (configQuery.isError || (requiresTerms && termsQuery.isError)) {
    content = (
      <Alert variant="error">
        <p>{localize('com_ui_code_setup_load_failed')}</p>
        <Button
          variant="outline"
          onClick={() => {
            if (configQuery.isError) {
              void configQuery.refetch();
            } else {
              void termsQuery.refetch();
            }
          }}
        >
          {localize('com_ui_retry')}
        </Button>
      </Alert>
    );
  } else if (!termsReady) {
    content =
      requiresTerms && termsQuery.data?.termsAccepted === false ? (
        <p role="status">{localize('com_ui_code_setup_terms')}</p>
      ) : (
        <Loading />
      );
  } else if (query.isError) {
    content = (
      <Alert variant="error">
        <p>
          {localize(
            unavailable ? 'com_ui_code_setup_unavailable' : 'com_ui_code_setup_load_failed',
          )}
        </p>
        {!unavailable && (
          <Button
            variant="outline"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {localize('com_ui_retry')}
          </Button>
        )}
      </Alert>
    );
  } else if (attempt == null || status == null) {
    content = <Loading />;
  } else {
    content = (
      <>
        <Alert variant={status === 'completed' ? 'success' : 'info'} role="status">
          {localize(
            status === 'failed' && attempt.failure?.retryable
              ? 'com_ui_code_setup_retryable'
              : statusKeys[status],
          )}
        </Alert>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-text-secondary text-sm">{localize('com_ui_code_setup_machine')}</dt>
            <dd className="font-medium break-words">{attempt.machineName}</dd>
          </div>
          <div>
            <dt className="text-text-secondary text-sm">{localize('com_ui_code_setup_code')}</dt>
            <dd className="font-mono text-lg">{attempt.verificationCode}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-text-secondary text-sm">
              {localize('com_ui_code_setup_fingerprint')}
            </dt>
            <dd className="font-mono text-sm break-all">{attempt.keyFingerprint}</dd>
          </div>
          <div>
            <dt className="text-text-secondary text-sm">
              {localize('com_ui_code_setup_workspace')}
            </dt>
            <dd>
              {localize(
                attempt.workspace.type === 'private'
                  ? 'com_ui_code_setup_private'
                  : 'com_ui_code_setup_directory',
              )}
            </dd>
          </div>
          <div>
            <dt className="text-text-secondary text-sm">{localize('com_ui_code_setup_expires')}</dt>
            <dd>
              <time dateTime={attempt.expiresAt}>
                {new Date(attempt.expiresAt).toLocaleString()}
              </time>
            </dd>
          </div>
          <div>
            <dt className="text-text-secondary text-sm">{localize('com_ui_code_setup_writes')}</dt>
            <dd>{localize(attempt.allowWorkspaceWrites ? 'com_ui_enabled' : 'com_ui_disabled')}</dd>
          </div>
          <div>
            <dt className="text-text-secondary text-sm">
              {localize('com_ui_code_setup_commands')}
            </dt>
            <dd>
              {localize(attempt.allowWorkspaceCommands ? 'com_ui_enabled' : 'com_ui_disabled')}
            </dd>
          </div>
          {attempt.controlPlaneId != null && (
            <div className="sm:col-span-2">
              <dt className="text-text-secondary text-sm">{localize('com_ui_code_setup_plane')}</dt>
              <dd>
                {attempt.controlPlanes.find((plane) => plane.id === attempt.controlPlaneId)?.name ??
                  localize('com_ui_code_setup_plane_unavailable')}
              </dd>
            </div>
          )}
        </dl>
        <Alert variant="warning" role="note">
          <p>{localize('com_ui_code_setup_verify')}</p>
          <p className="mt-2">{localize('com_ui_code_setup_command_warning')}</p>
          <p className="mt-2">{localize('com_ui_code_setup_trust_warning')}</p>
        </Alert>
        {mutationError != null && (
          <Alert variant="error">
            {localize(
              mutationUnavailable
                ? 'com_ui_code_setup_unavailable'
                : 'com_ui_code_setup_action_failed',
            )}
          </Alert>
        )}
        {canDecide && !expired && (
          <form
            aria-busy={isDeciding}
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !isDeciding &&
                selectedPlaneExists &&
                Date.parse(attempt.expiresAt) > Date.now()
              ) {
                approve.mutate({ controlPlaneId });
              }
            }}
            className="space-y-4"
          >
            <fieldset disabled={isDeciding} className="space-y-3">
              <legend className="mb-3 font-medium">{localize('com_ui_code_setup_plane')}</legend>
              {attempt.controlPlanes.map((plane) => (
                <div key={plane.id} className="flex items-center gap-3">
                  <input
                    id={`plane-${plane.id}`}
                    type="radio"
                    name="controlPlaneId"
                    value={plane.id}
                    checked={controlPlaneId === plane.id}
                    onChange={() => setControlPlaneId(plane.id)}
                  />
                  <Label htmlFor={`plane-${plane.id}`}>{plane.name}</Label>
                </div>
              ))}
              {attempt.controlPlanes.length === 0 && (
                <p>{localize('com_ui_code_setup_no_planes')}</p>
              )}
            </fieldset>
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                variant="submit"
                disabled={isDeciding || !selectedPlaneExists || mutationUnavailable}
              >
                {localize('com_ui_code_setup_approve')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={isDeciding || mutationUnavailable}
                onClick={() => deny.mutate(undefined)}
              >
                {localize('com_ui_code_setup_deny')}
              </Button>
            </div>
            {isDeciding && <p role="status">{localize('com_ui_code_setup_saving')}</p>}
          </form>
        )}
      </>
    );
  }

  return (
    <>
      {content}
      <TermsAndConditionsModal
        open={requiresTerms && termsQuery.data?.termsAccepted === false}
        onOpenChange={() => undefined}
        onAccept={() => {
          approve.reset();
          deny.reset();
        }}
        onDecline={() => logout('/login?redirect=false')}
        title={termsConfig?.modalTitle}
        modalContent={termsConfig?.modalContent}
      />
    </>
  );
}

export default function CodeSetup() {
  const localize = useLocalize();
  const location = useLocation();
  const { attemptId } = useParams();
  const { user, isAuthenticated, isAuthReady } = useAuthContext();
  if (!isAuthReady) {
    return (
      <Page>
        <Loading />
      </Page>
    );
  }
  if (!isAuthenticated) {
    return (
      <Navigate
        to={buildLoginRedirectUrl(location.pathname, location.search, location.hash)}
        replace
      />
    );
  }
  return (
    <Page>
      <p className="text-text-secondary text-sm">
        {localize('com_ui_code_setup_account', { 0: user?.email ?? user?.name ?? user?.id ?? '' })}
      </p>
      {user?.id != null && attemptId != null ? (
        <Review key={`${user.id}:${attemptId}`} userId={user.id} attemptId={attemptId} />
      ) : (
        <Alert variant="error">{localize('com_ui_code_setup_unavailable')}</Alert>
      )}
    </Page>
  );
}
