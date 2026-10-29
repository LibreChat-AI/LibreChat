import { useParams } from 'react-router-dom';
import { Button, Spinner } from '@librechat/client';
import { useResponseReview } from '~/data-provider/Responses';
import { AuthContextProvider } from '~/hooks/AuthContext';
import Controls from '~/components/Responses/Controls';
import Review from '~/components/Responses/Review';
import OAuth from '~/components/Responses/OAuth';
import useAuthRedirect from './useAuthRedirect';
import { useLocalize } from '~/hooks';

function ResponseReview() {
  const localize = useLocalize();
  const { responseId = '' } = useParams();
  const { user, isAuthenticated } = useAuthRedirect();
  const query = useResponseReview(
    responseId,
    isAuthenticated ? user?.id : undefined,
    user?.tenantId,
  );
  if (!isAuthenticated || !user || query.isLoading) return <Spinner />;
  if (query.isError || !query.data)
    return (
      <main className="mx-auto max-w-lg space-y-4 p-6">
        <h1 className="text-xl font-semibold">{localize('com_ui_response_review_title')}</h1>
        <p role="alert">{localize('com_ui_response_review_unavailable')}</p>
        <Button onClick={() => query.refetch()}>{localize('com_ui_retry')}</Button>
      </main>
    );
  const { status, oauth, recovery } = query.data;
  const running = status === 'queued' || status === 'in_progress';
  let statusLabel: Parameters<typeof localize>[0] = 'com_ui_response_review_stopped';
  if (status === 'completed') statusLabel = 'com_ui_response_review_complete';
  if (running) statusLabel = 'com_ui_response_review_running';
  if (running && oauth.length) statusLabel = 'com_ui_response_review_sign_in';
  if (recovery) statusLabel = 'com_ui_response_review_recovery';
  return (
    <main className="text-text-primary mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-xl font-semibold">{localize('com_ui_response_review_title')}</h1>
      <p role="status" aria-live="polite">
        {localize(statusLabel)}
      </p>
      {running && (
        <Controls
          key={JSON.stringify([user.id, user.tenantId, responseId])}
          responseId={responseId}
          userId={user.id}
          tenantId={user.tenantId}
        >
          {!recovery &&
            oauth
              .filter((prompt) => prompt.expiresAt > Date.now())
              .map((prompt) => (
                <OAuth
                  key={JSON.stringify([
                    user.id,
                    user.tenantId,
                    responseId,
                    prompt.actionId,
                    prompt.authURL,
                  ])}
                  prompt={prompt}
                />
              ))}
          {!recovery && (
            <Review
              review={query.data}
              userId={user.id}
              tenantId={user.tenantId}
              refresh={query.refetch}
            />
          )}
        </Controls>
      )}
      <p className="text-text-secondary text-sm">{localize('com_ui_response_review_return')}</p>
    </main>
  );
}

export default function ResponseReviewRoute() {
  return (
    <AuthContextProvider>
      <ResponseReview />
    </AuthContextProvider>
  );
}
