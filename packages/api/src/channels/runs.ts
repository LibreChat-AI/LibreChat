import { z } from 'zod';
import { ChannelRunConflict } from '@librechat/data-schemas';
import { responseReviewDecisionSchema } from 'librechat-data-provider';
import type {
  ChannelRunPrincipal,
  ChannelRunAdmission,
  ChannelRunView,
  ChannelRunSnapshot,
  ChannelRunSummary,
  ResponseReviewView,
} from 'librechat-data-provider';
import type {
  AgentChannelRecord,
  ChannelRunRecord,
  ChannelRunStorage,
  ResponseOwner,
} from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import type { ResponseDecisionSubmission } from '~/agents/responses/decision';
import type { createChannelArtifactService } from './artifacts';
import type { ChannelServiceGuard } from './types';
import { ChannelExecutionError } from './execution';
import { ChannelArtifactError } from './artifacts';

export type { ChannelServiceGuard } from './types';

export interface ChannelRunDependencies {
  interactive?: {
    readInteractiveReview: (
      owner: ResponseOwner,
      responseId: string,
    ) => Promise<ResponseReviewView | null>;
    submitInteractiveReview: ResponseDecisionSubmission;
  };
  responseCredential?: (run: ChannelRunRecord) => Promise<string>;
  storage: ChannelRunStorage;
  guard: ChannelServiceGuard;
  /** Live tenant membership, agent ACL and explicit channel/link authority, never payload userId. */
  resolvePrincipal: (
    channel: AgentChannelRecord,
    actor: ChannelRunAdmission['actor'],
  ) => Promise<ChannelRunPrincipal | null>;
  advance: (
    run: ChannelRunRecord,
  ) => Promise<{ snapshot: ChannelRunSnapshot; generationCreatedAt?: number }>;
  retireForAuthorityLoss: (run: ChannelRunRecord) => Promise<'stopped' | 'pending'>;
  now?: () => number;
  leaseMs?: number;
  getLeaseMs?: () => Promise<number>;
  publicBaseUrl?: string;
  artifacts?: ReturnType<typeof createChannelArtifactService>;
  /** Optional final metadata only; the caller checks live authority on both sides. */
  summarize?: (run: ChannelRunRecord, snapshot: ChannelRunSnapshot) => Promise<ChannelRunSummary>;
}

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w:.-]+$/);
const actorSchema = z.object({ teamId: id, appId: id, externalUserId: id }).strict();
const fenceSchema = z.object({ runId: id, owner: id, epoch: z.number().int().positive() }).strict();
const admissionSchema = z
  .object({
    eventId: id,
    externalChannelId: id,
    externalThreadKey: id,
    externalMessageKey: id,
    actor: actorSchema,
    input: z.string().min(1).max(100_000),
  })
  .strict();
const fenceBody = z.object({ fence: fenceSchema }).strict();
/** Fixed wire safety bound, not a provider's rendering limit. Content remains opaque to Agents. */
const presentationSchema = z
  .object({
    format: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    payload: z
      .string()
      .max(64_000)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 64_000)
      .refine((value) => {
        try {
          const parsed: unknown = JSON.parse(value);
          return parsed !== null && typeof parsed === 'object';
        } catch {
          return false;
        }
      }),
  })
  .strict();
const planBody = z
  .object({
    fence: fenceSchema,
    plan: z
      .object({
        revision: id,
        rendererVersion: id,
        parts: z
          .array(
            z
              .object({
                operationId: id,
                kind: z.enum(['message', 'artifact']),
                required: z.boolean(),
                text: z.string().max(40_000),
                presentation: presentationSchema.optional(),
                artifactId: id.optional(),
              })
              .strict()
              .refine((part) => !part.presentation || part.kind === 'message'),
          )
          .min(1)
          .max(100),
      })
      .strict(),
  })
  .strict();
const beginBody = z.object({ fence: fenceSchema, operationId: id }).strict();
const uploadBody = z
  .object({
    fence: fenceSchema,
    operationId: id,
    attempts: z.number().int().positive(),
    upload: z.object({ fileId: id, stage: z.enum(['allocated', 'uploaded']) }).strict(),
  })
  .strict();
const progressRevision = z.number().int().positive();
const progressPlanBody = z
  .object({
    fence: fenceSchema,
    revision: progressRevision,
    rendererVersion: id,
    text: z.string().max(4000),
  })
  .strict();
const progressBeginBody = z.object({ fence: fenceSchema, revision: progressRevision }).strict();
const progressSettleBody = z
  .object({
    fence: fenceSchema,
    revision: progressRevision,
    receipt: z
      .object({
        outcome: z.enum(['confirmed', 'retryable', 'unknown', 'permanent_failure']),
        attempts: z.number().int().positive(),
        externalMessageKey: id.optional(),
        retryAt: z.number().int().nonnegative().optional(),
        errorCode: id.optional(),
      })
      .strict(),
  })
  .strict();
const settleBody = z
  .object({
    fence: fenceSchema,
    receipt: z
      .object({
        operationId: id,
        outcome: z.enum(['confirmed', 'retryable', 'unknown', 'permanent_failure']),
        attempts: z.number().int().positive(),
        externalMessageKey: id.optional(),
        externalFileId: id.optional(),
        retryAt: z.number().int().nonnegative().optional(),
        errorCode: id.optional(),
      })
      .strict(),
  })
  .strict();

/** Service projection deliberately omits execution credentials and internal principal identifiers. */
export function channelRunView(run: ChannelRunRecord): ChannelRunView {
  return {
    runId: run.runId,
    channelId: run.channelId,
    revision: run.principal.channelRevision,
    state: run.state,
    admission: run.admission,
    sequence: run.sequence,
    snapshot: run.snapshot,
    progress: run.progress,
    plan: run.plan,
    receipts: run.receipts,
    cancellationRequested: run.cancellationRequested,
  };
}

export type ChannelRunHandlers = Record<
  | 'review'
  | 'submitReview'
  | 'cancel'
  | 'stopThread'
  | 'admit'
  | 'claim'
  | 'renew'
  | 'yieldLease'
  | 'advance'
  | 'prepareResponse'
  | 'bindResponse'
  | 'plan'
  | 'planProgress'
  | 'beginProgress'
  | 'settleProgress'
  | 'begin'
  | 'checkpointUpload'
  | 'artifact'
  | 'settle'
  | 'commit',
  RequestHandler
>;

export async function hasChannelRunAuthority(
  channel: AgentChannelRecord,
  run: ChannelRunRecord,
  resolve: ChannelRunDependencies['resolvePrincipal'],
): Promise<boolean> {
  if (run.errorCode === 'channel_authority_changed' || channel.status !== 'active') return false;
  const principal = await resolve(channel, run.admission.actor);
  return Boolean(
    principal &&
      principal.userId === run.principal.userId &&
      principal.channelRevision === run.principal.channelRevision &&
      principal.linkId === run.principal.linkId &&
      principal.linkRevision === run.principal.linkRevision,
  );
}

export function createChannelRunHandlers(deps: ChannelRunDependencies): ChannelRunHandlers {
  const now = deps.now ?? Date.now;
  const getLeaseMs = deps.getLeaseMs ?? (async () => deps.leaseMs ?? 60_000);
  async function hasAuthority(channel: AgentChannelRecord, run: ChannelRunRecord) {
    return hasChannelRunAuthority(channel, run, deps.resolvePrincipal);
  }
  async function retireAuthorityLost(
    run: ChannelRunRecord,
    fence: Parameters<ChannelRunStorage['markAuthorityLost']>[1],
  ) {
    const stopped = await deps.storage.markAuthorityLost(run.tenantId, fence, now());
    if ((await deps.retireForAuthorityLoss(stopped)) === 'stopped')
      await deps.storage.finishAuthorityLost(run.tenantId, fence, now());
  }
  const guarded = (handler: Parameters<ChannelServiceGuard>[0]) =>
    deps.guard(async (req, res, channel) => {
      res.set('Cache-Control', 'no-store');
      try {
        await handler(req, res, channel);
      } catch (error) {
        if (
          error instanceof ChannelRunConflict ||
          error instanceof ChannelArtifactError ||
          error instanceof ChannelExecutionError
        ) {
          res.status(409).json({ error: error.code });
          return;
        }
        throw error;
      }
    });
  async function bound(
    req: Request,
    res: Response,
    channel: AgentChannelRecord,
    rawFence: unknown,
  ) {
    const fence = fenceSchema.safeParse(rawFence);
    if (!fence.success || fence.data.runId !== req.params.runId) {
      res.status(400).json({ error: 'invalid_run_fence' });
      return null;
    }
    const run = await deps.storage.read(
      channel.tenantId ?? '_',
      channel.channelId,
      fence.data.runId,
    );
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return null;
    }
    if (!(await hasAuthority(channel, run))) {
      await retireAuthorityLost(run, fence.data);
      res.status(403).json({ error: 'channel_authority_changed' });
      return null;
    }
    return { run, fence: fence.data };
  }
  async function actionRun(
    req: Request,
    res: Response,
    channel: AgentChannelRecord,
    decision = false,
  ) {
    const schema = z.object({ actor: actorSchema, revision: id, externalChannelId: id.optional() });
    const parsed = (decision ? schema.extend({ decision: responseReviewDecisionSchema }) : schema)
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_run_action' });
      return;
    }
    const { actor, revision } = parsed.data;
    const run = await deps.storage.read(
      channel.tenantId ?? '_',
      channel.channelId,
      req.params.runId,
    );
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    if (
      actor.teamId !== run.admission.actor.teamId ||
      actor.appId !== run.admission.actor.appId ||
      actor.externalUserId !== run.admission.actor.externalUserId ||
      (parsed.data.externalChannelId != null &&
        parsed.data.externalChannelId !== run.admission.externalChannelId) ||
      revision !== run.principal.channelRevision
    ) {
      res.status(403).json({ error: 'channel_action_forbidden' });
      return;
    }
    const principal = await deps.resolvePrincipal(channel, actor);
    if (
      !principal ||
      principal.userId !== run.principal.userId ||
      principal.channelRevision !== revision ||
      principal.linkId !== run.principal.linkId ||
      principal.linkRevision !== run.principal.linkRevision
    ) {
      res.status(403).json({ error: 'channel_authority_changed' });
      return;
    }
    return run;
  }
  return {
    stopThread: guarded(async (req, res, channel) => {
      const parsed = z
        .object({
          actor: actorSchema,
          externalThreadKey: id,
          eventAt: z.number().int().positive().max(now()),
        })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_run_action' });
        return;
      }
      const { actor, externalThreadKey, eventAt } = parsed.data;
      if (actor.teamId !== channel.slack?.teamId || actor.appId !== channel.slack?.appId) {
        res.status(403).json({ error: 'channel_action_forbidden' });
        return;
      }
      const principal = await deps.resolvePrincipal(channel, actor);
      if (!principal) {
        res.status(403).json({ error: 'channel_authority_changed' });
        return;
      }
      const run = await deps.storage.readActiveThread(
        channel.tenantId ?? '_',
        channel.channelId,
        externalThreadKey,
        actor.externalUserId,
        principal,
        eventAt,
      );
      if (!run || !(await hasAuthority(channel, run))) {
        res.json({ cancellationRequested: false });
        return;
      }
      const accepted = await deps.storage.requestCancel(
        channel.tenantId ?? '_',
        channel.channelId,
        run.runId,
        actor.externalUserId,
      );
      res.status(accepted ? 202 : 200).json({ cancellationRequested: accepted });
    }),
    review: guarded(async (req, res, channel) => {
      const run = await actionRun(req, res, channel);
      if (!run) return;
      if (
        !deps.publicBaseUrl ||
        run.cancellationRequested ||
        run.state !== 'requires_action' ||
        !run.execution ||
        (run.execution.protocol === 'responses' && !run.execution.responseId) ||
        !run.snapshot?.pendingAction ||
        run.snapshot.pendingAction.expiresAt <= now()
      ) {
        res.status(409).json({ error: 'run_action_unavailable' });
        return;
      }
      const url = new URL(
        run.execution.protocol === 'responses'
          ? `/responses/${encodeURIComponent(run.execution.responseId!)}/review`
          : `/c/${encodeURIComponent(run.execution.conversationId)}`,
        deps.publicBaseUrl,
      );
      const view =
        run.execution.protocol === 'responses' &&
        deps.interactive &&
        req.body.externalChannelId === run.admission.externalChannelId
          ? await deps.interactive.readInteractiveReview(
              {
                userId: run.principal.userId,
                tenantId: run.tenantId === '_' ? undefined : run.tenantId,
              },
              run.execution.responseId!,
            )
          : null;
      if (!(await hasAuthority(channel, run))) {
        res.status(403).json({ error: 'channel_authority_changed' });
        return;
      }
      const pending =
        view?.canSubmitDecision &&
        view.pendingAction?.actionId === run.snapshot.pendingAction.actionId
          ? view.pendingAction
          : undefined;
      res.json({
        url: url.toString(),
        actionId: run.snapshot.pendingAction.actionId,
        ...(pending ? { pendingAction: pending } : {}),
        ...(pending && view?.pendingDecision ? { pendingDecision: view.pendingDecision } : {}),
      });
    }),
    submitReview: guarded(async (req, res, channel) => {
      const run = await actionRun(req, res, channel, true);
      if (!run) return;
      if (
        !deps.interactive ||
        run.execution?.protocol !== 'responses' ||
        !run.execution.responseId ||
        run.cancellationRequested ||
        !req.body.externalChannelId
      ) {
        res.status(409).json({ error: 'run_action_unavailable' });
        return;
      }
      // The caller cannot select a principal or Response. Current run authority derives both.
      const result = await deps.interactive.submitInteractiveReview(
        { userId: run.principal.userId, tenantId: run.tenantId === '_' ? undefined : run.tenantId },
        run.execution.responseId,
        req.body.decision,
      );
      if (!result.ok) {
        res.status(result.status).json({ error: result.code });
        return;
      }
      res.status(202).json(result.receipt);
    }),
    cancel: guarded(async (req, res, channel) => {
      const run = await actionRun(req, res, channel);
      if (!run) return;
      const accepted = await deps.storage.requestCancel(
        channel.tenantId ?? '_',
        channel.channelId,
        run.runId,
        run.admission.actor.externalUserId,
      );
      res
        .status(accepted ? 202 : 409)
        .json(accepted ? { cancellationRequested: true } : { error: 'run_not_cancellable' });
    }),
    admit: guarded(async (req, res, channel) => {
      const parsed = admissionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_channel_event' });
        return;
      }
      const admission = parsed.data;
      if (
        admission.actor.teamId !== channel.slack?.teamId ||
        admission.actor.appId !== channel.slack?.appId
      ) {
        res.status(403).json({ error: 'channel_actor_mismatch' });
        return;
      }
      const principal = await deps.resolvePrincipal(channel, admission.actor);
      if (!principal) {
        res.status(403).json({ error: 'channel_link_required' });
        return;
      }
      const result = await deps.storage.admit(
        {
          tenantId: channel.tenantId ?? '_',
          channelId: channel.channelId,
          agentId: channel.agentId,
          principal,
          admission,
        },
        now(),
      );
      res
        .status(result.duplicate ? 200 : 201)
        .json({ runId: result.run.runId, duplicate: result.duplicate });
    }),
    claim: guarded(async (req, res, channel) => {
      const parsed = z.object({ owner: id }).strict().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_run_claim' });
        return;
      }
      const run = await deps.storage.claim(
        channel.tenantId ?? '_',
        channel.channelId,
        parsed.data.owner,
        now(),
        await getLeaseMs(),
      );
      if (!run) {
        res.status(204).end();
        return;
      }
      if (!(await hasAuthority(channel, run))) {
        await retireAuthorityLost(run, {
          runId: run.runId,
          owner: run.leaseOwner!,
          epoch: run.leaseEpoch,
        });
        res.status(204).end();
        return;
      }
      res.json({
        run: channelRunView(run),
        fence: { runId: run.runId, owner: run.leaseOwner, epoch: run.leaseEpoch },
        leaseExpiresAt: run.leaseExpiresAt,
      });
    }),
    renew: guarded(async (req, res, channel) => {
      const parsed = fenceBody.safeParse(req.body);
      const binding = await bound(req, res, channel, parsed.success ? parsed.data.fence : null);
      if (!binding) return;
      const at = now();
      const leaseMs = await getLeaseMs();
      if (!(await deps.storage.renew(channel.tenantId ?? '_', binding.fence, at, leaseMs))) {
        res.status(409).json({ error: 'stale_fence' });
        return;
      }
      res.json({ fence: binding.fence, leaseExpiresAt: at + leaseMs });
    }),
    yieldLease: guarded(async (req, res, channel) => {
      const parsed = fenceBody.safeParse(req.body);
      const binding = await bound(req, res, channel, parsed.success ? parsed.data.fence : null);
      if (!binding) return;
      if (
        !(await deps.storage.yieldLease(
          channel.tenantId ?? '_',
          channel.channelId,
          binding.fence,
          now(),
        ))
      ) {
        res.status(409).json({ error: 'run_yield_unavailable' });
        return;
      }
      res.status(204).end();
    }),
    prepareResponse: guarded(async (req, res, channel) => {
      const parsed = fenceBody.safeParse(req.body);
      const binding = await bound(req, res, channel, parsed.success ? parsed.data.fence : null);
      if (!binding) return;
      let run = await deps.storage.prepareExecution(channel.tenantId ?? '_', binding.fence, now());
      if (!run.execution || run.execution.deliveryKey || run.execution.enqueueAttemptedAt) {
        res.status(409).json({ error: 'execution_protocol_conflict' });
        return;
      }
      if (run.cancellationRequested && !run.execution.apiKeyId) {
        const settled = await deps.storage.finishUnstartedResponseCancellation(
          channel.tenantId ?? '_',
          binding.fence,
          now(),
        );
        res.json({ settled: channelRunView(settled) });
        return;
      }
      if (run.cancellationRequested && !run.execution.responseId) {
        const recovered = await deps.storage.recoverResponse(
          channel.tenantId ?? '_',
          binding.fence,
          now(),
        );
        if (!recovered) {
          res.status(409).json({ error: 'response_cancellation_pending' });
          return;
        }
        run = recovered;
      }
      if (!deps.responseCredential) {
        res.status(503).json({ error: 'response_credential_unavailable' });
        return;
      }
      const apiKey = await deps.responseCredential(run);
      if (!(await hasAuthority(channel, run))) {
        res.status(403).json({ error: 'channel_authority_changed' });
        return;
      }
      res.json({
        apiKey,
        requestKey: `channel:${run.runId}`,
        responseId: run.execution!.responseId,
        request: {
          model: run.agentId,
          input: run.admission.input,
          background: true,
          store: true,
          ...(run.execution!.parentMessageId === '00000000-0000-0000-0000-000000000000'
            ? {}
            : { previous_response_id: run.execution!.parentMessageId }),
        },
      });
    }),
    bindResponse: guarded(async (req, res, channel) => {
      const parsed = z.object({ fence: fenceSchema, responseId: id }).strict().safeParse(req.body);
      const binding = await bound(req, res, channel, parsed.success ? parsed.data.fence : null);
      if (!binding || !parsed.success) return;
      const run = await deps.storage.bindResponse(
        channel.tenantId ?? '_',
        binding.fence,
        parsed.data.responseId,
        now(),
      );
      res.json(channelRunView(run));
    }),
    advance: guarded(async (req, res, channel) => {
      const parsed = fenceBody.safeParse(req.body);
      const binding = await bound(req, res, channel, parsed.success ? parsed.data.fence : null);
      if (!binding) return;
      const { fence } = binding;
      let run = binding.run;
      if (run.plan || ['delivered', 'failed', 'cancelled'].includes(run.state)) {
        res.json(channelRunView(run));
        return;
      }
      run = await deps.storage.prepareExecution(channel.tenantId ?? '_', fence, now());
      const result = await deps.advance(run);
      if (deps.artifacts && result.snapshot.status === 'completed') {
        try {
          const projection = await deps.artifacts.list(run, result.snapshot);
          result.snapshot.artifacts = projection.artifacts;
          result.snapshot.artifactsUnavailable = projection.unavailable;
        } catch {
          result.snapshot.artifactsUnavailable = true;
        }
      }
      if (!(await hasAuthority(channel, run))) {
        await retireAuthorityLost(run, fence);
        res.status(403).json({ error: 'channel_authority_changed' });
        return;
      }
      if (run.snapshot?.summary) result.snapshot.summary = run.snapshot.summary;
      else if (
        deps.summarize &&
        ['completed', 'failed', 'cancelled'].includes(result.snapshot.status)
      ) {
        try {
          result.snapshot.summary = await deps.summarize(run, result.snapshot);
        } catch {
          // Optional accounting/trace metadata must not withhold a valid answer.
          delete result.snapshot.summary;
        }
        if (!(await hasAuthority(channel, run))) {
          await retireAuthorityLost(run, fence);
          res.status(403).json({ error: 'channel_authority_changed' });
          return;
        }
      }
      run = await deps.storage.saveSnapshot(
        channel.tenantId ?? '_',
        fence,
        result.snapshot,
        now(),
        result.generationCreatedAt,
      );
      res.json(channelRunView(run));
    }),
    plan: guarded(async (req, res, channel) => {
      const parsed = planBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_delivery_plan' });
        return;
      }
      const binding = await bound(req, res, channel, parsed.data.fence);
      if (!binding) return;
      if (
        parsed.data.plan.parts.some(
          (part) =>
            part.kind === 'artifact' &&
            !binding.run.snapshot?.artifacts?.some(
              (artifact) => artifact.artifactId === part.artifactId,
            ),
        )
      ) {
        res.status(400).json({ error: 'invalid_artifact_reference' });
        return;
      }
      res.json(
        channelRunView(
          await deps.storage.savePlan(
            channel.tenantId ?? '_',
            binding.fence,
            parsed.data.plan,
            now(),
          ),
        ),
      );
    }),
    planProgress: guarded(async (req, res, channel) => {
      const parsed = progressPlanBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_progress_plan' });
        return;
      }
      const binding = await bound(req, res, channel, parsed.data.fence);
      if (!binding) return;
      const { revision, rendererVersion, text } = parsed.data;
      res.json(
        channelRunView(
          await deps.storage.planProgress(
            channel.tenantId ?? '_',
            binding.fence,
            { revision, rendererVersion, text },
            now(),
          ),
        ),
      );
    }),
    beginProgress: guarded(async (req, res, channel) => {
      const parsed = progressBeginBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_progress_operation' });
        return;
      }
      const binding = await bound(req, res, channel, parsed.data.fence);
      if (!binding) return;
      res.json(
        channelRunView(
          await deps.storage.beginProgress(
            channel.tenantId ?? '_',
            binding.fence,
            parsed.data.revision,
            now(),
          ),
        ),
      );
    }),
    settleProgress: guarded(async (req, res, channel) => {
      const parsed = progressSettleBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_progress_receipt' });
        return;
      }
      const binding = await bound(req, res, channel, parsed.data.fence);
      if (!binding) return;
      const key = parsed.data.receipt.externalMessageKey;
      if (key && !key.startsWith(`${binding.run.admission.externalChannelId}:`)) {
        res.status(400).json({ error: 'delivery_destination_mismatch' });
        return;
      }
      res.json(
        channelRunView(
          await deps.storage.settleProgress(
            channel.tenantId ?? '_',
            binding.fence,
            { ...parsed.data.receipt, revision: parsed.data.revision },
            now(),
          ),
        ),
      );
    }),
    begin: guarded(async (req, res, channel) => {
      const parsed = beginBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_delivery_operation' });
        return;
      }
      const binding = await bound(req, res, channel, parsed.data.fence);
      if (!binding) return;
      res.json(
        channelRunView(
          await deps.storage.beginDelivery(
            channel.tenantId ?? '_',
            binding.fence,
            parsed.data.operationId,
            now(),
          ),
        ),
      );
    }),
    checkpointUpload: guarded(async (req, res, channel) => {
      const parsed = uploadBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_upload_checkpoint' });
        return;
      }
      const binding = await bound(req, res, channel, parsed.data.fence);
      if (!binding) return;
      res.json(
        channelRunView(
          await deps.storage.checkpointUpload(
            channel.tenantId ?? '_',
            binding.fence,
            parsed.data.operationId,
            parsed.data.attempts,
            parsed.data.upload,
            now(),
          ),
        ),
      );
    }),
    artifact: guarded(async (req, res, channel) => {
      const parsed = fenceBody.safeParse(req.body);
      const binding = await bound(req, res, channel, parsed.success ? parsed.data.fence : null);
      if (!binding) return;
      const leased = () =>
        binding.run.leaseOwner === binding.fence.owner &&
        binding.run.leaseEpoch === binding.fence.epoch &&
        binding.run.leaseExpiresAt > now();
      if (!leased()) {
        res.status(409).json({ error: 'stale_fence' });
        return;
      }
      if (!deps.artifacts) {
        res.status(404).json({ error: 'artifact_unavailable' });
        return;
      }
      const content = await deps.artifacts.content(binding.run, req.params.artifactId);
      if (!(await bound(req, res, channel, binding.fence))) return;
      if (!leased()) {
        res.status(409).json({ error: 'stale_fence' });
        return;
      }
      res.set('X-Artifact-Filename', encodeURIComponent(content.descriptor.filename));
      res.set('X-Artifact-Media-Type', content.descriptor.mediaType);
      res.set('X-Artifact-SHA256', content.descriptor.sha256);
      res.type('application/octet-stream').send(content.bytes);
    }),
    settle: guarded(async (req, res, channel) => {
      const parsed = settleBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_delivery_receipt' });
        return;
      }
      const binding = await bound(req, res, channel, parsed.data.fence);
      if (!binding) return;
      const key = parsed.data.receipt.externalMessageKey;
      if (key && !key.startsWith(`${binding.run.admission.externalChannelId}:`)) {
        res.status(400).json({ error: 'delivery_destination_mismatch' });
        return;
      }
      res.json(
        channelRunView(
          await deps.storage.settleDelivery(
            channel.tenantId ?? '_',
            binding.fence,
            parsed.data.receipt,
            now(),
          ),
        ),
      );
    }),
    commit: guarded(async (req, res, channel) => {
      const parsed = fenceBody.safeParse(req.body);
      const binding = await bound(req, res, channel, parsed.success ? parsed.data.fence : null);
      if (!binding) return;
      res.json(
        channelRunView(
          await deps.storage.commitDelivery(channel.tenantId ?? '_', binding.fence, now()),
        ),
      );
    }),
  };
}
