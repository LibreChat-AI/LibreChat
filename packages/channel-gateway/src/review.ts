import { z } from 'zod';
import type { Agents, ChannelRunActor, ResponseReviewDecision } from 'librechat-data-provider';
import type { PlainTextElement, ModalView, InputBlock, Button } from '@slack/types';
import type { SlackClient, SlackBlocks } from './slack';
import type { ChannelBundle, Review } from './types';
import type { ChannelClient } from './client';
import { IdentityFlow, safePrivateURL } from './identity';
import { ServiceError } from './client';

type PendingAction = NonNullable<Review['pendingAction']>;
type Question = Agents.AskUserQuestionRequest & { id?: string };
export interface ReviewInteraction {
  teamId: string;
  appId: string;
  actorId: string;
  channelId: string;
  triggerId?: string;
  view?: { callbackId: string; privateMetadata: string; values?: ReviewValues };
}
export type ReviewValues = Record<
  string,
  Record<
    string,
    { value?: string; selected_option?: { value: string }; selected_options?: { value: string }[] }
  >
>;
export type ReviewAck =
  | { response_action: 'clear' }
  | { response_action: 'update'; view: ModalView }
  | { response_action: 'errors'; errors: Record<string, string> };
const controlSchema = z
  .object({ runId: z.string().min(1).max(256), revision: z.string().min(1).max(256) })
  .strict();
const referenceSchema = controlSchema
  .extend({
    actionId: z.string().min(1).max(256),
    channelId: z.string().min(1).max(256),
    actorId: z.string().min(1).max(256),
    expiresAt: z.number().finite(),
    savedIntentId: z.string().min(1).optional(),
  })
  .strict();
const choiceSchema = referenceSchema.extend({ choice: z.number().int().min(0).max(3) }).strict();
type Reference = z.infer<typeof referenceSchema>;
const plain = (text: string): PlainTextElement => ({ type: 'plain_text', text });
const questions = (payload: Agents.AskUserQuestionInterruptPayload): Question[] =>
  payload.questions?.length ? payload.questions : [payload.question];
const unavailable = () =>
  notice(
    'Review unavailable',
    'This action changed, expired, or is no longer authorized. A previous decision may already have been accepted and cannot be replaced. Close this window and check the latest thread status before trying again.',
  );
function notice(title: string, text: string): ReviewAck {
  return {
    response_action: 'update',
    view: {
      type: 'modal',
      title: plain(title),
      close: plain('Close'),
      blocks: [{ type: 'section', text: plain(text) }],
    },
  };
}
function expectedFailure(error: unknown): boolean {
  return error instanceof ServiceError && [400, 403, 404, 409, 410].includes(error.status);
}
function parseReference(value: string): Reference {
  if (value.length > 3000) throw new Error('Invalid private review reference');
  return referenceSchema.parse(JSON.parse(value));
}
function actor(interaction: ReviewInteraction, bundle: ChannelBundle): ChannelRunActor {
  if (
    !interaction.actorId ||
    interaction.teamId !== bundle.channel.slack.teamId ||
    interaction.appId !== bundle.channel.slack.appId
  )
    throw new Error('Review actor binding changed');
  return {
    teamId: interaction.teamId,
    appId: interaction.appId,
    externalUserId: interaction.actorId,
  };
}
function validReference(
  ref: Reference,
  interaction: ReviewInteraction,
  bundle: ChannelBundle,
): boolean {
  return (
    ref.actorId === interaction.actorId &&
    (!interaction.channelId || ref.channelId === interaction.channelId) &&
    ref.revision === bundle.channel.revision &&
    ref.expiresAt > Date.now()
  );
}
function matches(
  ref: Reference,
  review: Review,
): review is Review & { pendingAction: PendingAction } {
  return (
    !!review.pendingAction &&
    review.actionId === ref.actionId &&
    review.pendingAction.actionId === ref.actionId &&
    review.pendingAction.expiresAt === ref.expiresAt
  );
}
export function simpleChoices(action: PendingAction): boolean {
  const payload = action.payload;
  if (
    payload.type !== 'ask_user_question' ||
    payload.questions?.length ||
    payload.question.multiSelect
  )
    return false;
  const question = payload.question;
  return (
    !!question.options?.length &&
    question.options.length <= 4 &&
    question.question.length <= 2800 &&
    (question.description?.length ?? 0) <= 2800 &&
    question.options.every((option) => !!option.label && option.label.length <= 75)
  );
}

export function reviewModal(ref: Reference, action: PendingAction): ModalView | null {
  if (action.actionId !== ref.actionId || !action.expiresAt || action.expiresAt <= Date.now())
    throw new Error('Review expired');
  const blocks: SlackBlocks = [];
  const payload = action.payload;
  if (payload.type === 'ask_user_question') {
    const batch = questions(payload);
    if (!batch.length || batch.length > 20) return null;
    for (const [i, question] of batch.entries()) {
      if (
        !question.question ||
        question.question.length > 2000 ||
        (question.description?.length ?? 0) > 2000 ||
        (question.options?.length ?? 0) > 100
      )
        return null;
      if (question.options?.length) {
        if (question.options.some((option) => !option.label || option.label.length > 75))
          return null;
        const options = question.options.map((option, n) => ({
          text: plain(option.label),
          value: String(n),
        }));
        const element: InputBlock['element'] = question.multiSelect
          ? { type: 'multi_static_select', action_id: 'choice', options }
          : { type: 'static_select', action_id: 'choice', options };
        blocks.push(
          { type: 'section', text: plain(question.question) },
          {
            type: 'input',
            block_id: `question_${i}`,
            label: plain('Choose an answer'),
            optional: true,
            element,
          },
        );
      }
      if (question.description) blocks.push({ type: 'section', text: plain(question.description) });
      blocks.push({
        type: 'input',
        block_id: `question_${i}_text`,
        label: plain(question.options?.length ? 'Or write an answer' : question.question),
        optional: !!question.options?.length,
        element: {
          type: 'plain_text_input',
          action_id: 'answer',
          multiline: true,
          max_length: 3000,
        },
      });
    }
  } else if (payload.type === 'tool_approval') {
    if (!payload.action_requests.length || payload.action_requests.length > 20) return null;
    for (const [i, call] of payload.action_requests.entries()) {
      const text = `${call.name}\n${call.description ?? ''}\nArguments: ${typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)}`;
      const allowed =
        payload.review_configs.find((config) => config.tool_call_id === call.tool_call_id)
          ?.allowed_decisions ?? [];
      const options = [...new Set(allowed)]
        .filter((value) => value === 'approve' || value === 'reject')
        .map((value) => ({ text: plain(value === 'approve' ? 'Approve' : 'Decline'), value }));
      if (text.length > 2800 || !options.length) return null;
      blocks.push(
        { type: 'section', text: plain(text) },
        {
          type: 'input',
          block_id: `tool_${i}`,
          label: plain('Decision for this call only'),
          element: { type: 'radio_buttons', action_id: 'decision', options },
        },
      );
    }
  } else return null;
  if (blocks.length > 95) return null;
  return {
    type: 'modal',
    callback_id: 'channel_native_review',
    private_metadata: JSON.stringify(ref),
    title: plain('Agent needs your input'),
    submit: plain('Send answer'),
    close: plain('Not now'),
    blocks,
  };
}

export function nativeDecision(
  action: PendingAction,
  values: ReviewValues,
): ResponseReviewDecision {
  const payload = action.payload;
  if (payload.type === 'tool_approval') {
    return {
      actionId: action.actionId,
      decisions: payload.action_requests.map((call, i) => {
        const decision = values[`tool_${i}`]?.decision?.selected_option?.value;
        const allowed = payload.review_configs.find(
          (config) => config.tool_call_id === call.tool_call_id,
        )?.allowed_decisions;
        if ((decision !== 'approve' && decision !== 'reject') || !allowed?.includes(decision))
          throw new Error('Decision not allowed');
        return { tool_call_id: call.tool_call_id, decision, scope: 'once' };
      }),
    };
  }
  const answers: Record<string, string> = {};
  const batch = questions(payload);
  if (!batch.length || batch.length > 20) throw new Error('Invalid question batch');
  let single = '';
  for (const [i, question] of batch.entries()) {
    const key = `question_${i}`;
    let answer = values[`${key}_text`]?.answer?.value?.trim() ?? '';
    const field = values[key]?.choice;
    const selected = [
      ...(field?.selected_options ?? []),
      ...(field?.selected_option ? [field.selected_option] : []),
    ];
    if (
      (answer && selected.length) ||
      (!question.multiSelect && selected.length > 1) ||
      new Set(selected.map((option) => option.value)).size !== selected.length ||
      answer.length > 3000
    )
      throw new Error('Choose or write one answer');
    if (selected.length)
      answer = selected
        .map((option) => {
          if (!/^(0|[1-9][0-9]*)$/.test(option.value)) throw new Error('Invalid choice');
          const selectedOption = question.options?.[Number(option.value)];
          if (!selectedOption) throw new Error('Invalid choice');
          return selectedOption.value;
        })
        .join(', ');
    if (!answer) throw new Error('Answer required');
    if (payload.questions?.length) {
      if (!question.id || Object.hasOwn(answers, question.id))
        throw new Error('Invalid question identifier');
      Object.defineProperty(answers, question.id, { value: answer, enumerable: true });
    } else single = answer;
  }
  return payload.questions?.length
    ? { actionId: action.actionId, answers }
    : { actionId: action.actionId, answer: single };
}

function decisionReceipt(
  ref: Reference,
  action: PendingAction,
  decision: ResponseReviewDecision,
): ModalView {
  const blocks: SlackBlocks = [
    {
      type: 'section',
      text: plain(
        'Your decision is saved. Continuation is not confirmed. Retry sends only this same saved decision; it cannot change the approval or answer.',
      ),
    },
  ];
  if (action.payload.type === 'tool_approval')
    for (const call of action.payload.action_requests) {
      const accepted = decision.decisions?.find(
        (item) => item.tool_call_id === call.tool_call_id,
      )?.decision;
      let label = 'Decision received';
      if (accepted === 'approve') label = 'Tool call approved';
      if (accepted === 'reject') label = 'Tool call declined';
      blocks.push({
        type: 'section',
        text: plain(`${label}: ${[...call.name].slice(0, 200).join('')}`),
      });
    }
  return {
    type: 'modal',
    title: plain('Decision received'),
    close: plain('Close'),
    callback_id: 'channel_native_review',
    private_metadata: JSON.stringify(ref),
    submit: plain('Retry continuation'),
    blocks,
  };
}
function decisionConfirmation(action: PendingAction, decision: ResponseReviewDecision): string {
  if (action.payload.type !== 'tool_approval') return 'Answer received.';
  const approved = decision.decisions?.filter((item) => item.decision === 'approve').length ?? 0;
  const declined = decision.decisions?.filter((item) => item.decision === 'reject').length ?? 0;
  if (approved === 1 && !declined) return 'Tool call approved.';
  if (declined === 1 && !approved) return 'Tool call declined.';
  return `Tool calls approved: ${approved}; declined: ${declined}.`;
}

export class ReviewFlow {
  private readonly identity: IdentityFlow;
  constructor(
    private readonly client: ChannelClient,
    private readonly slack: SlackClient,
    private readonly appTitle: string,
  ) {
    this.identity = new IdentityFlow(client, slack);
  }

  async control(
    actionId: string,
    value: string,
    interaction: ReviewInteraction,
    bundle: ChannelBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    const caller = actor(interaction, bundle);
    if (value.length > 1024 || !interaction.channelId) throw new Error('Invalid run control');
    const control = controlSchema.parse(JSON.parse(value));
    if (control.revision !== bundle.channel.revision)
      return this.reject(interaction, bundle, signal);
    try {
      if (actionId === 'channel_run_cancel') {
        if (
          !(await this.client.cancel(control.runId, caller, control.revision, signal))
            .cancellationRequested
        )
          throw new Error('Cancellation was not accepted');
        return this.identity.notify(
          interaction.channelId,
          interaction.actorId,
          'Cancellation requested. Work that has already completed cannot be undone; the final status will appear in this thread.',
          bundle,
          undefined,
          signal,
        );
      }
      if (actionId !== 'channel_run_review' && actionId !== 'channel_native_write')
        throw new Error('Unsupported run control');
      let review: Review;
      try {
        review = await this.client.review(
          control.runId,
          caller,
          control.revision,
          interaction.channelId,
          signal,
        );
      } catch (error) {
        if (!(error instanceof ServiceError && error.status === 400)) throw error;
        review = await this.client.review(
          control.runId,
          caller,
          control.revision,
          undefined,
          signal,
        );
      }
      if (review.pendingAction && interaction.triggerId) {
        if (!review.pendingAction.expiresAt) throw new Error('Review expiry unavailable');
        const ref: Reference = {
          ...control,
          actionId: review.actionId,
          channelId: interaction.channelId,
          actorId: interaction.actorId,
          expiresAt: review.pendingAction.expiresAt,
        };
        if (!matches(ref, review) || !validReference(ref, interaction, bundle))
          throw new Error('Review changed');
        let modal: ModalView | null;
        if (review.pendingDecision) {
          if (
            !review.pendingDecision.intentId ||
            review.pendingDecision.decision.actionId !== ref.actionId
          )
            throw new Error('Invalid saved decision');
          ref.savedIntentId = review.pendingDecision.intentId;
          modal = decisionReceipt(ref, review.pendingAction, review.pendingDecision.decision);
        } else if (actionId !== 'channel_native_write' && simpleChoices(review.pendingAction)) {
          return this.choices(ref, review.pendingAction, bundle, signal);
        } else modal = reviewModal(ref, review.pendingAction);
        if (modal) {
          if (safePrivateURL(review.url)) {
            modal.blocks.push({
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: plain(`Open in ${this.appTitle}`),
                  action_id: 'channel_run_open',
                  url: review.url,
                },
              ],
            });
          }
          await this.slack.openView(
            bundle.credentials.botToken,
            interaction.triggerId,
            modal,
            signal,
          );
          return;
        }
      }
      if (!safePrivateURL(review.url) || !review.actionId)
        throw new Error('Invalid private review link');
      await this.identity.notify(
        interaction.channelId,
        interaction.actorId,
        `Review this request in ${this.appTitle}. Approval or sign-in happens there; no action was approved in Slack.`,
        bundle,
        { label: `Review in ${this.appTitle}`, action: 'channel_run_open', url: review.url },
        signal,
      );
    } catch (error) {
      if (!expectedFailure(error)) throw error;
      await this.reject(interaction, bundle, signal);
    }
  }

  private async reject(
    interaction: ReviewInteraction,
    bundle: ChannelBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.identity.notify(
      interaction.channelId,
      interaction.actorId,
      'This action is unavailable, expired, or not authorized for you. Check the latest reply in this thread.',
      bundle,
      undefined,
      signal,
    );
  }

  private async choices(
    ref: Reference,
    action: PendingAction,
    bundle: ChannelBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    if (action.payload.type !== 'ask_user_question') throw new Error('Invalid question');
    const question = action.payload.question;
    const buttons: Button[] = (question.options ?? []).map((option, choice) => ({
      type: 'button',
      text: plain(option.label),
      action_id: `channel_native_choice_${choice}`,
      value: JSON.stringify({ ...ref, choice }),
    }));
    buttons.push({
      type: 'button',
      text: plain('Write an answer'),
      action_id: 'channel_native_write',
      value: JSON.stringify({ runId: ref.runId, revision: ref.revision }),
    });
    const blocks: SlackBlocks = [{ type: 'section', text: plain(question.question) }];
    if (question.description) blocks.push({ type: 'section', text: plain(question.description) });
    blocks.push({ type: 'actions', elements: buttons });
    await this.slack.ephemeral(
      bundle.credentials.botToken,
      {
        channel: ref.channelId,
        user: ref.actorId,
        text: 'The Agent has a question for you.',
        blocks,
      },
      signal,
    );
  }

  async choice(
    value: string,
    interaction: ReviewInteraction,
    bundle: ChannelBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    const caller = actor(interaction, bundle);
    if (value.length > 3000) throw new Error('Invalid private choice');
    const ref = choiceSchema.parse(JSON.parse(value));
    if (!validReference(ref, interaction, bundle)) return this.reject(interaction, bundle, signal);
    const review = await this.client.review(ref.runId, caller, ref.revision, ref.channelId, signal);
    if (
      !matches(ref, review) ||
      review.pendingDecision ||
      !simpleChoices(review.pendingAction) ||
      review.pendingAction.payload.type !== 'ask_user_question'
    )
      return this.reject(interaction, bundle, signal);
    const option = review.pendingAction.payload.question.options?.[ref.choice];
    if (!option) throw new Error('Private choice changed');
    await this.client.decide(
      ref.runId,
      caller,
      ref.revision,
      ref.channelId,
      { actionId: ref.actionId, answer: option.value },
      signal,
    );
    await this.identity.notify(
      ref.channelId,
      ref.actorId,
      'Answer received.',
      bundle,
      undefined,
      signal,
    );
  }

  async submit(
    interaction: ReviewInteraction,
    bundle: ChannelBundle,
    signal?: AbortSignal,
  ): Promise<ReviewAck> {
    const caller = actor(interaction, bundle);
    if (interaction.view?.callbackId !== 'channel_native_review')
      throw new Error('Invalid native review submission');
    const ref = parseReference(interaction.view.privateMetadata);
    if (!validReference(ref, interaction, bundle)) return unavailable();
    try {
      const review = await this.client.review(
        ref.runId,
        caller,
        ref.revision,
        ref.channelId,
        signal,
      );
      if (!matches(ref, review)) return unavailable();
      let decision: ResponseReviewDecision;
      if (review.pendingDecision) {
        const saved = review.pendingDecision;
        if (
          !saved.intentId ||
          saved.decision.actionId !== ref.actionId ||
          (ref.savedIntentId && ref.savedIntentId !== saved.intentId)
        )
          return unavailable();
        if (!ref.savedIntentId)
          return {
            response_action: 'update',
            view: decisionReceipt(
              { ...ref, savedIntentId: saved.intentId },
              review.pendingAction,
              saved.decision,
            ),
          };
        decision = saved.decision;
      } else {
        if (ref.savedIntentId || !interaction.view.values) return unavailable();
        try {
          decision = nativeDecision(review.pendingAction, interaction.view.values);
        } catch {
          const payload = review.pendingAction.payload;
          let input = 'tool_0';
          if (payload.type === 'ask_user_question') {
            input = questions(payload)[0]?.options?.length ? 'question_0' : 'question_0_text';
          }
          return {
            response_action: 'errors',
            errors: {
              [input]: 'Choose or write one answer for each question, or a decision for each tool.',
            },
          };
        }
      }
      await this.client.decide(ref.runId, caller, ref.revision, ref.channelId, decision, signal);
      // Decorative acknowledgement cannot turn an accepted decision into a failed submission.
      void this.identity
        .notify(
          ref.channelId,
          ref.actorId,
          decisionConfirmation(review.pendingAction, decision),
          bundle,
          undefined,
          signal,
        )
        .catch(() => {});
      return { response_action: 'clear' };
    } catch (error) {
      return expectedFailure(error)
        ? unavailable()
        : notice(
            'Submission unconfirmed',
            "The decision submission was not confirmed. It may already be saved. Close this window and reopen the thread's review to check its current state and retry only the saved decision. Do not assume the tool ran or repeat the task.",
          );
    }
  }
}
