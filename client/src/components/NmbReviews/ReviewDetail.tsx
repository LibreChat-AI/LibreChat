import { useState } from 'react';
import { Button, Spinner, Textarea, useToastContext } from '@librechat/client';
import type { TNmbReview } from 'librechat-data-provider';
import {
  useNmbMeQuery,
  useNmbOriginalQuery,
  useRejectNmbReviewMutation,
  useApproveNmbReviewMutation,
} from '~/data-provider';
import ApproveForm from './ApproveForm';
import FindingsList from './FindingsList';
import OriginalView from './OriginalView';
import { useLocalize } from '~/hooks';

const MIN_REASON = 3;

export default function ReviewDetail({
  review,
  onDone,
}: {
  review: TNmbReview;
  onDone: () => void;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: me } = useNmbMeQuery();
  const pending = review.status === 'pending';
  /** The original is fetched only now, when a reviewer opens the item, and only if still pending. */
  const original = useNmbOriginalQuery(pending ? review.id : undefined);
  const [reason, setReason] = useState('');

  const fail = () => showToast({ message: localize('com_nmb_action_failed'), status: 'error' });
  const approve = useApproveNmbReviewMutation({
    onSuccess: () => {
      showToast({ message: localize('com_nmb_approved_toast'), status: 'success' });
      onDone();
    },
    onError: fail,
  });
  const reject = useRejectNmbReviewMutation({
    onSuccess: () => {
      showToast({ message: localize('com_nmb_rejected_toast'), status: 'success' });
      onDone();
    },
    onError: fail,
  });
  const busy = approve.isLoading || reject.isLoading;

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-text-secondary">{localize('com_nmb_user')}</dt>
          <dd>{review.user_label}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">{localize('com_nmb_department')}</dt>
          <dd>{review.department ?? '-'}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">{localize('com_nmb_submitted')}</dt>
          <dd>{new Date(review.created_at).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-text-secondary">{localize('com_nmb_source')}</dt>
          <dd>
            {review.source === 'file'
              ? localize('com_nmb_source_file')
              : localize('com_nmb_source_text')}
          </dd>
        </div>
      </dl>
      {review.reason && <p className="text-text-secondary text-sm">{review.reason}</p>}
      <FindingsList findings={review.findings} />

      {!pending && (
        <p className="text-text-secondary text-sm">
          {review.status === 'rejected'
            ? localize('com_nmb_resolved_rejected', { 0: review.reviewer_note ?? '' })
            : localize('com_nmb_resolved_approved')}
        </p>
      )}

      {pending && original.isLoading && <Spinner className="size-5" />}
      {pending && original.isError && (
        <p role="alert" className="text-text-destructive text-sm">
          {localize('com_nmb_original_unavailable')}
        </p>
      )}
      {pending && original.data && (
        <>
          <OriginalView original={original.data} findings={review.findings} />
          <ApproveForm
            original={original.data}
            findings={review.findings}
            regexEnabled={me?.regexBlocklist === true}
            busy={busy}
            onApprove={(body) => approve.mutate({ id: review.id, body })}
          />
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">{localize('com_nmb_reject')}</h4>
            <Textarea
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
              placeholder={localize('com_nmb_reject_reason_placeholder')}
              aria-label={localize('com_nmb_reject_reason_placeholder')}
            />
            <div>
              <Button
                type="button"
                variant="destructive"
                disabled={busy || reason.trim().length < MIN_REASON}
                onClick={() => reject.mutate({ id: review.id, body: { reason: reason.trim() } })}
              >
                {localize('com_nmb_reject')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
