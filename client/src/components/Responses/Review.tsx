import { useCallback, useEffect, useRef, useState } from 'react';
import { Provider } from 'jotai';
import { isAxiosError } from 'axios';
import { Button } from '@librechat/client';
import type { ResponseReviewDecision, ResponseReviewView } from 'librechat-data-provider';
import type { ResumeSubmitTransport } from '~/components/Chat/Messages/Content/ApprovalContext';
import ApprovalProvider, {
  ResumeSubmitContext,
} from '~/components/Chat/Messages/Content/ApprovalContext';
import AskUserQuestion from '~/components/Chat/Messages/Content/AskUserQuestion';
import ToolApproval from '~/components/Chat/Messages/Content/ToolApproval';
import { useResponseReviewDecision } from '~/data-provider/Responses';
import { useResponseInteraction } from './Controls';
import { useLocalize } from '~/hooks';

interface ReviewProps {
  review: ResponseReviewView;
  userId: string;
  tenantId?: string;
  refresh: () => Promise<{ data?: ResponseReviewView; isError: boolean }>;
}

export default function Review(props: ReviewProps) {
  return (
    <Provider
      key={JSON.stringify([
        props.userId,
        props.tenantId,
        props.review.responseId,
        props.review.pendingAction?.actionId,
      ])}
    >
      <ApprovalProvider pendingAction={props.review.pendingAction}>
        <Decision {...props} />
      </ApprovalProvider>
    </Provider>
  );
}

function Decision({ review, userId, tenantId, refresh }: ReviewProps) {
  const localize = useLocalize();
  const mutation = useResponseReviewDecision(review.responseId, userId, tenantId);
  const [attempt, setAttempt] = useState<ResponseReviewDecision>();
  const [failed, setFailed] = useState(false);
  const [correctable, setCorrectable] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef(false);
  const enabled = useResponseInteraction();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useRef({ review, enabled });
  current.current = { review, enabled };
  const action = review.pendingAction;
  const expiresAt = action?.expiresAt;
  useEffect(() => {
    setNow(Date.now());
    if (expiresAt == null || expiresAt <= Date.now()) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(expiresAt - Date.now(), 2147483647),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const expired = expiresAt != null && expiresAt <= now;
  const running = review.status === 'queued' || review.status === 'in_progress';
  const actionAvailable = running && review.canSubmitDecision === true && !expired;
  const available = enabled && actionAvailable;
  const saved = review.pendingDecision?.decision ?? attempt;
  const submit = useCallback(
    async (decision: ResponseReviewDecision) => {
      const { review: latest, enabled: interactive } = current.current;
      const pending = latest.pendingAction;
      if (
        !mounted.current ||
        !interactive ||
        inFlight.current ||
        !latest.canSubmitDecision ||
        !['queued', 'in_progress'].includes(latest.status) ||
        !pending ||
        pending.actionId !== decision.actionId ||
        (pending.expiresAt != null && pending.expiresAt <= Date.now())
      )
        throw new Error('Response review is unavailable');
      inFlight.current = true;
      setFailed(false);
      setCorrectable(false);
      setSubmitted(false);
      setAttempt(decision);
      try {
        await mutation.mutateAsync(decision);
        if (!mounted.current) throw new Error('Response review is unavailable');
        setSubmitted(true);
      } catch (error) {
        if (!mounted.current) throw error;
        setFailed(true);
        // The request may already have reserved a durable decision. Keep the exact
        // attempt immutable until the owner's refreshed view confirms its state.
        const refreshed = await refresh().catch(() => undefined);
        const response = isAxiosError<{ error?: string }>(error) ? error.response : undefined;
        const rejected =
          (response?.status === 400 && response.data?.error === 'invalid_response_decision') ||
          (response?.status === 403 && response.data?.error === 'response_decision_rejected');
        if (
          mounted.current &&
          rejected &&
          !latest.pendingDecision &&
          refreshed &&
          !refreshed.isError &&
          refreshed.data?.responseId === latest.responseId &&
          refreshed.data.pendingAction?.actionId === decision.actionId &&
          !refreshed.data.pendingDecision
        ) {
          setAttempt(undefined);
          setCorrectable(true);
        }
        throw error;
      } finally {
        inFlight.current = false;
      }
    },
    [mutation, refresh],
  );
  const transport: ResumeSubmitTransport = {
    submitAskAnswer: (actionId, resolution) => {
      if (saved) throw new Error('Response review is unavailable');
      return submit({
        actionId,
        ...(typeof resolution === 'string' ? { answer: resolution } : { answers: resolution }),
      });
    },
    submitToolApproval: (actionId, decisions) => {
      if (saved) throw new Error('Response review is unavailable');
      return submit({ actionId, decisions });
    },
  };

  if (!action && !saved) return null;
  return (
    <section aria-label={localize('com_ui_response_review_decision')} className="space-y-3">
      {!available && (
        <p role="status">
          {localize(expired ? 'com_ui_approval_expired' : 'com_ui_response_review_disabled')}
        </p>
      )}
      {failed && (
        <p role="alert">
          {localize(
            correctable
              ? 'com_ui_response_review_decision_invalid'
              : 'com_ui_response_review_decision_error',
          )}
        </p>
      )}
      {saved && (
        <>
          <p>{localize('com_ui_response_review_saved')}</p>
          <pre
            className="bg-surface-secondary overflow-auto rounded-lg p-3 text-sm break-words whitespace-pre-wrap"
            aria-label={localize('com_ui_response_review_saved')}
          >
            {JSON.stringify(saved, null, 2)}
          </pre>
          {submitted && <p role="status">{localize('com_ui_response_review_decision_queued')}</p>}
          {!submitted && (
            <Button
              disabled={!available || mutation.isLoading || saved.actionId !== action?.actionId}
              onClick={() => void submit(saved).catch(() => {})}
            >
              {localize(mutation.isLoading ? 'com_ui_submitting' : 'com_ui_retry')}
            </Button>
          )}
        </>
      )}
      {!saved && actionAvailable && action && (
        <fieldset disabled={!available} aria-disabled={!available}>
          <ResumeSubmitContext.Provider value={transport}>
            <Requests action={action} />
          </ResumeSubmitContext.Provider>
        </fieldset>
      )}
    </section>
  );
}

function Requests({ action }: { action: NonNullable<ResponseReviewView['pendingAction']> }) {
  const localize = useLocalize();
  const { payload } = action;
  if (payload.type === 'ask_user_question') {
    return (
      <AskUserQuestion
        actionId={action.actionId}
        question={payload.question}
        questions={payload.questions}
      />
    );
  }
  const configs = new Map(payload.review_configs.map((config) => [config.tool_call_id, config]));
  if (
    !payload.action_requests.length ||
    payload.action_requests.some((request) => !configs.has(request.tool_call_id))
  ) {
    return <p role="alert">{localize('com_ui_response_review_disabled')}</p>;
  }
  return (
    <>
      {payload.action_requests.map((request) => {
        const config = configs.get(request.tool_call_id);
        if (!config) return null;
        return (
          <div key={request.tool_call_id} className="space-y-2">
            <h2 className="font-semibold">{request.name}</h2>
            <pre className="bg-surface-secondary overflow-auto rounded-lg p-3 text-sm break-words whitespace-pre-wrap">
              {typeof request.arguments === 'string'
                ? request.arguments
                : JSON.stringify(request.arguments, null, 2)}
            </pre>
            <ToolApproval
              toolCallId={request.tool_call_id}
              args={request.arguments}
              approval={{ ...config, actionId: action.actionId, description: request.description }}
            />
          </div>
        );
      })}
    </>
  );
}
