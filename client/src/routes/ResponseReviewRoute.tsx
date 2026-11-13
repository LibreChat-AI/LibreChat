import { Button, Spinner } from '@librechat/client';
import { buildLoginRedirectUrl } from 'librechat-data-provider';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useOwnerActionPolicy, OwnerTermsModal } from '~/hooks/useOwnerActionPolicy';
import { useResponseReview } from '~/data-provider/Responses';
import { AuthContextProvider } from '~/hooks/AuthContext';
import Controls from '~/components/Responses/Controls';
import { useAuthContext, useLocalize } from '~/hooks';
import Review from '~/components/Responses/Review';
import OAuth from '~/components/Responses/OAuth';

function OwnedReview({
  responseId,
  userId,
  tenantId,
}: {
  responseId: string;
  userId: string;
  tenantId?: string;
}) {
  const localize = useLocalize();
  const policy = useOwnerActionPolicy();
  const { config, terms, requiresTerms, termsReady, policyError } = policy;
  const query = useResponseReview(responseId, userId, tenantId);
  const review = query.data;
  const readError = query.isError || (!query.isLoading && !review);
  const enabled = termsReady && !policyError && !readError;
  const retry = () => {
    if (config.isError) void config.refetch();
    else if (requiresTerms && terms.isError) void terms.refetch();
    else void query.refetch();
  };
  const running = review?.status === 'queued' || review?.status === 'in_progress';
  let statusLabel: Parameters<typeof localize>[0] = 'com_ui_response_review_stopped';
  if (review?.status === 'completed') statusLabel = 'com_ui_response_review_complete';
  if (running) statusLabel = 'com_ui_response_review_running';
  if (running && review.oauth.length) statusLabel = 'com_ui_response_review_sign_in';
  if (review?.recovery) statusLabel = 'com_ui_response_review_recovery';
  return (
    <main className="text-text-primary mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-xl font-semibold">{localize('com_ui_response_review_title')}</h1>
      {(readError || policyError) && (
        <div className="space-y-3" role="alert">
          <p>{localize('com_ui_response_review_unavailable')}</p>
          <Button
            onClick={retry}
            disabled={query.isFetching || config.isFetching || (requiresTerms && terms.isFetching)}
          >
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {requiresTerms && terms.data?.termsAccepted === false && !policyError && (
        <p role="status">{localize('com_ui_response_review_terms')}</p>
      )}
      {((!review && query.isLoading) ||
        (!policyError && (!config.isSuccess || (requiresTerms && !terms.isSuccess)))) && (
        <Spinner />
      )}
      {review && (
        <>
          <p role="status" aria-live="polite">
            {localize(statusLabel)}
          </p>
          {running && (
            <Controls responseId={responseId} userId={userId} tenantId={tenantId} enabled={enabled}>
              {!review.recovery &&
                review.oauth
                  .filter((prompt) => prompt.expiresAt > Date.now())
                  .map((prompt) => (
                    <OAuth
                      key={JSON.stringify([
                        userId,
                        tenantId,
                        responseId,
                        prompt.actionId,
                        prompt.authURL,
                      ])}
                      prompt={prompt}
                    />
                  ))}
              {!review.recovery && (
                <Review
                  review={review}
                  userId={userId}
                  tenantId={tenantId}
                  refresh={query.refetch}
                />
              )}
            </Controls>
          )}
          <p className="text-text-secondary text-sm">{localize('com_ui_response_review_return')}</p>
        </>
      )}
      <OwnerTermsModal
        policy={policy}
        onAccepted={() => {
          void query.refetch();
        }}
      />
    </main>
  );
}

function ResponseReview() {
  const { responseId = '' } = useParams();
  const { user, isAuthenticated, isAuthReady } = useAuthContext();
  const location = useLocation();
  if (!isAuthReady) return <Spinner />;
  if (!isAuthenticated)
    return (
      <Navigate
        to={buildLoginRedirectUrl(location.pathname, location.search, location.hash)}
        replace
      />
    );
  if (!user?.id) return <Spinner />;
  return (
    <OwnedReview
      key={JSON.stringify([user.id, user.tenantId, responseId])}
      responseId={responseId}
      userId={user.id}
      tenantId={user.tenantId}
    />
  );
}

export default function ResponseReviewRoute() {
  return (
    <AuthContextProvider>
      <ResponseReview />
    </AuthContextProvider>
  );
}
