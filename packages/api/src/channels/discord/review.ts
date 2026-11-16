import { z } from 'zod';
import {
  discordDecisionControl,
  responseReviewDecisionSchema,
  responseReviewDecisionReceiptSchema,
} from 'librechat-data-provider';
import type {
  ResponseReviewView,
  ResponseReviewDecision,
  DiscordPrivateReply,
} from 'librechat-data-provider';
import type { AgentChannelRecord, DiscordCommandScope } from '@librechat/data-schemas';
import type { DiscordCommandStorage } from '@librechat/data-schemas';
import type { ChannelRunDependencies } from '../runs';
import { hasChannelRunAuthority } from '../runs';

const contextSchema = z.object({
  runId: z.string(),
  responseId: z.string(),
  userId: z.string(),
  linkId: z.string(),
  linkRevision: z.string(),
  expiresAt: z.number(),
  choices: z.array(responseReviewDecisionSchema).min(1).max(4),
  receipt: z
    .object({ choice: z.number().int(), value: responseReviewDecisionReceiptSchema })
    .optional(),
});
const unavailable: DiscordPrivateReply = {
  content:
    'This review is no longer available to you. Use /librechat status for the current request.',
};
// Preserve complete short values. Complex or long requests need the full browser form.
function safeText(value: string): string {
  return value.replace(/[`<>@\\]/g, ' ');
}
export function projectDiscordReview(view: ResponseReviewView): {
  content: string;
  labels: string[];
  choices: ResponseReviewDecision[];
} | null {
  const action = view.pendingAction;
  if (!view.canSubmitDecision || !action || view.pendingDecision || view.oauth.length) return null;
  const payload = action.payload;
  if (payload.type === 'tool_approval') {
    if (payload.action_requests.length !== 1 || payload.review_configs.length !== 1) return null;
    const request = payload.action_requests[0];
    const config = payload.review_configs.find(
      (item) => item.tool_call_id === request.tool_call_id,
    );
    if (
      !config?.allowed_decisions.includes('approve') ||
      !config.allowed_decisions.includes('reject')
    )
      return null;
    const argumentsText = JSON.stringify(request.arguments, null, 2).replace(
      /`/g,
      String.raw`\u0060`,
    );
    const decisions: Array<'approve' | 'reject'> = ['approve', 'reject'];
    if (
      !safeText(request.name).trim() ||
      request.name.length > 120 ||
      request.tool_call_id.length > 256 ||
      argumentsText.length > 1100
    )
      return null;
    return {
      content: `Review tool request: ${safeText(request.name)}\nArguments (JSON):\n\`\`\`json\n${argumentsText}\n\`\`\`\nApprove once permits only this request. Decline refuses it.`,
      labels: ['Approve once', 'Decline'],
      choices: decisions.map((decision) => ({
        actionId: action.actionId,
        decisions: [
          {
            tool_call_id: request.tool_call_id,
            decision,
            scope: 'once',
          },
        ],
      })),
    };
  }
  if (payload.type !== 'ask_user_question' || (payload.questions && payload.questions.length !== 1))
    return null;
  const question = payload.questions?.[0] ?? payload.question;
  const options = question.options;
  if (
    question.multiSelect ||
    !options?.length ||
    options.length > 4 ||
    question.question.length + (question.description?.length ?? 0) > 1000 ||
    options.some(
      (option) =>
        !safeText(option.label).trim() ||
        option.label.length > 80 ||
        !option.value.trim() ||
        option.value.length > 2000,
    ) ||
    new Set(options.map((option) => option.value)).size !== options.length ||
    new Set(options.map((option) => safeText(option.label))).size !== options.length
  )
    return null;
  return {
    content: safeText(
      question.description ? `${question.question}\n${question.description}` : question.question,
    ),
    labels: options.map((option) => safeText(option.label)),
    choices: options.map((option) => ({
      actionId: action.actionId,
      ...(payload.questions
        ? { answers: { [payload.questions[0].id]: option.value } }
        : { answer: option.value }),
    })),
  };
}

/** Native controls use canonical decisions and receipts; no model-generated control is executable. */
export function createDiscordReviewHandler(deps: {
  commands: DiscordCommandStorage;
  interactive: NonNullable<ChannelRunDependencies['interactive']>;
  resolvePrincipal: ChannelRunDependencies['resolvePrincipal'];
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
  publicBaseUrl: string;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return async (
    scope: DiscordCommandScope,
    channel: AgentChannelRecord,
    statusRunId?: string,
  ): Promise<DiscordPrivateReply> => {
    const { record } = scope;
    const action = record.action;
    if (!action) return unavailable;
    if (action.kind !== 'review' && action.kind !== 'decide' && action.kind !== 'status')
      return unavailable;
    if (action.kind === 'status' && !statusRunId) return unavailable;
    let saved: z.infer<typeof contextSchema> | undefined;
    let encrypted: string | undefined;
    if (action.kind === 'decide') {
      const result = await deps.commands.readReview(scope, action.reference, now());
      if (!result.ok || !result.value) return unavailable;
      encrypted = result.value;
      saved = contextSchema.parse(JSON.parse(await deps.decrypt(encrypted)));
    }
    const selected = await deps.commands.reviewRun(
      scope,
      now(),
      saved?.runId ?? (action.kind === 'status' ? statusRunId! : action.reference),
      action.kind === 'review' ? action.messageId : undefined,
    );
    if (!selected.ok || !selected.value) return unavailable;
    const run = selected.value;
    const responseId =
      run.execution?.protocol === 'responses' ? run.execution.responseId : undefined;
    const authorized = () => hasChannelRunAuthority(channel, run, deps.resolvePrincipal);
    if (run.cancellationRequested || !(await authorized())) return unavailable;
    const url = new URL(
      responseId
        ? `responses/${encodeURIComponent(responseId)}/review`
        : `c/${encodeURIComponent(run.execution?.conversationId ?? '')}`,
      `${deps.publicBaseUrl.replace(/\/+$/, '')}/`,
    ).href;
    if (action.kind === 'decide') {
      if (
        !saved ||
        !encrypted ||
        !responseId ||
        saved.responseId !== responseId ||
        saved.userId !== scope.principal.userId ||
        saved.linkId !== scope.principal.linkId ||
        saved.linkRevision !== scope.principal.linkRevision
      )
        return unavailable;
      const decision = saved.choices[action.choice];
      if (!decision) return unavailable;
      if (saved.receipt)
        return saved.receipt.choice === action.choice
          ? {
              content:
                'Your decision was already recorded. This request will not be submitted again.',
            }
          : unavailable;
      // The canonical service rechecks expiry, action identity, source authority and equivalent retries.
      const result = await deps.interactive.submitInteractiveReview(
        { userId: run.principal.userId, tenantId: run.tenantId === '_' ? undefined : run.tenantId },
        responseId,
        decision,
      );
      if (!result.ok) return unavailable;
      if (result.receipt.responseId !== responseId || result.receipt.actionId !== decision.actionId)
        throw new Error('Discord review receipt identity mismatch');
      await deps.commands.updateReview(
        scope,
        action.reference,
        encrypted,
        await deps.encrypt(
          JSON.stringify({ ...saved, receipt: { choice: action.choice, value: result.receipt } }),
        ),
        now(),
      );
      if (!(await authorized())) return unavailable;
      return receiptReply(result.receipt.status);
    }
    if (
      run.state !== 'requires_action' ||
      !run.snapshot?.pendingAction ||
      run.snapshot.pendingAction.expiresAt <= now()
    )
      return unavailable;
    const browser: DiscordPrivateReply = {
      content: 'This request needs the full private review in LibreChat. Open it to continue.',
      actions: [{ label: 'Open in LibreChat', url }],
    };
    if (!responseId) return browser;
    const view = await deps.interactive.readInteractiveReview(
      { userId: run.principal.userId, tenantId: run.tenantId === '_' ? undefined : run.tenantId },
      responseId,
    );
    if (!(await authorized())) return unavailable;
    if (
      !view ||
      view.pendingAction?.actionId !== run.snapshot.pendingAction.actionId ||
      view.pendingAction.expiresAt !== run.snapshot.pendingAction.expiresAt ||
      view.pendingAction.expiresAt <= now()
    )
      return browser;
    const projection = projectDiscordReview(view);
    if (!projection) return browser;
    const context = {
      runId: run.runId,
      responseId,
      userId: run.principal.userId,
      linkId: run.principal.linkId,
      linkRevision: run.principal.linkRevision,
      expiresAt: view.pendingAction.expiresAt,
      choices: projection.choices,
    };
    const serialized = JSON.stringify(context);
    if (Buffer.byteLength(serialized, 'utf8') > 16384) return browser;
    const persisted = await deps.commands.saveReview(scope, await deps.encrypt(serialized), now());
    if (!persisted.ok || !(await authorized())) return unavailable;
    const immutable = contextSchema.parse(JSON.parse(await deps.decrypt(persisted.value)));
    if (JSON.stringify(immutable) !== JSON.stringify(context)) return unavailable;
    return {
      content: `${projection.content}\nThese controls expire with this private interaction.`,
      actions: [
        ...projection.labels.map((label, choice) => ({
          label,
          reference: discordDecisionControl(record.eventId, choice),
          style: choice === 0 ? ('primary' as const) : ('secondary' as const),
        })),
        { label: 'Open in LibreChat', url },
      ],
    };
  };
}
function receiptReply(status: 'queued' | 'settled'): DiscordPrivateReply {
  return {
    content:
      status === 'settled'
        ? 'Your decision was already recorded and processing has finished.'
        : 'Your decision is recorded and queued for processing. It has not completed yet.',
  };
}
