import { deriveMediaThreadTitle } from '@librechat/data-schemas';
import type { MediaConfig, MediaErrorCode, MediaWorkerHealth } from 'librechat-data-provider';
import type { MediaJobObservation, MediaStoredJob } from '@librechat/data-schemas';
import type { MediaProviderContext, MediaProviderPart, MediaProviderResult } from './provider';
import type { MediaServices, MediaServiceDependencies, MediaContext } from './service';
import type { MediaLifecycleEvent } from './telemetry';
import {
  getMediaTerminalRecovery,
  resolveMediaJobIntegration,
  hasRejectedMediaSubmission,
} from './recovery';
import { mediaDiagnosticSecrets, sanitizeMediaProviderDiagnostic } from './diagnostics';
import { restoreMediaOutputResult, publishMediaOutputs } from './worker/outputs';
import { observeMedia, mediaJobEvent, withMediaAttempt } from './telemetry';
import { createMediaDispatchGate, waitForMediaDrain } from './worker/drain';
import { assertMediaAccess, mediaAccountingMode } from './service';
import { MediaServiceError, MediaProviderError } from './errors';
import { isMediaConnectionBinding } from './provider';
import { scopeMediaTransport } from './transport';
import { mediaActivityChanged } from './events';

export interface MediaWorker {
  start(): Promise<void>;
  prepareForShutdown(): Promise<void>;
  stop(options?: { budgetMs?: number }): Promise<void>;
  runJob(job: MediaStoredJob): Promise<void>;
  readonly available: boolean;
  readonly health: MediaWorkerHealth;
}

export function createMediaWorker(
  deps: MediaServiceDependencies,
  services: MediaServices,
  baseConfig: MediaConfig,
): MediaWorker {
  let stopped = true;
  let state: MediaWorkerHealth['state'] = 'unavailable';
  let consecutiveScanFailures = 0;
  let lastScanAt: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
  let scanning: Promise<void> | undefined;
  let maintaining: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let lifecycle = 0;
  let dueCursor: string | undefined;
  let cleanupCursor: string | undefined;
  let accountingCursor: string | undefined;
  let permitCursor: string | undefined;
  const active = new Map<string, Promise<void>>();
  const titleControllers = new Set<AbortController>();
  const controllers = new Set<AbortController>();
  const adapters = new Map(deps.adapters.map((adapter) => [adapter.api, adapter]));
  const workerId = deps.id();
  const dispatchGate = createMediaDispatchGate();

  const health = (): MediaWorkerHealth => ({ state, consecutiveScanFailures, lastScanAt });
  function setState(next: MediaWorkerHealth['state']) {
    state = next;
    observeMedia(deps.observer, {
      kind: 'worker',
      result: next === 'unavailable' ? 'failed' : 'completed',
      worker: health(),
    });
  }
  function recordScan(success: boolean) {
    if (stopped) return;
    lastScanAt = new Date(deps.now()).toISOString();
    consecutiveScanFailures = success ? 0 : consecutiveScanFailures + 1;
    if (consecutiveScanFailures >= baseConfig.worker.scanFailureThreshold) {
      if (state !== 'unavailable')
        deps.log(
          '[media] Worker unavailable after repeated scan failures; polling continues for recovery.',
        );
      setState('unavailable');
    } else {
      setState(success ? 'armed' : state);
    }
  }

  function startTitle(job: MediaStoredJob, context: MediaContext, parentSignal: AbortSignal) {
    const generate = deps.titles;
    if (
      !generate ||
      job.request.threadId ||
      (job.temporary ?? job.request.temporary) ||
      parentSignal.aborted ||
      !dispatchGate.accepting
    )
      return;
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    titleControllers.add(controller);
    const work = Promise.resolve()
      .then(async () => {
        if (!dispatchGate.accepting || signal.aborted) return;
        const title = await generate({
          context,
          jobId: job.jobId,
          threadId: job.threadId,
          prompt: job.request.prompt,
          operation: job.operation,
          currentTitle: deriveMediaThreadTitle(
            job.request.prompt,
            context.config.limits.maxTitleChars,
          ),
          signal,
        });
        if (title)
          void deps
            .publishActivity?.(context.scope, {
              threadId: job.threadId,
              version: job.version,
            })
            .catch((error: unknown) =>
              deps.log(
                'Media activity delivery failed; snapshots remain available.',
                error instanceof Error ? error : undefined,
              ),
            );
      })
      .catch((error: unknown) => {
        if (!signal.aborted)
          deps.log('[media] Title generation failed.', error instanceof Error ? error : undefined);
      })
      .finally(() => {
        titleControllers.delete(controller);
      });
    return { work, controller };
  }

  async function execute(initial: MediaStoredJob): Promise<void> {
    let job = initial;
    const startedAt = deps.now();
    let phaseStartedAt = startedAt;
    let attemptFailed = false;
    let failureCode: MediaErrorCode | undefined;
    let finishDispatch: (() => void) | undefined;
    let title: ReturnType<typeof startTitle>;
    const finishTitle = async () => {
      title?.controller.abort();
      await title?.work;
    };
    observeMedia(deps.observer, {
      ...mediaJobEvent(job),
      kind: 'attempt',
      result: 'started',
      ...(job.phase === 'queued'
        ? { queueWaitMs: Math.max(0, startedAt - job.createdAt.getTime()) }
        : {}),
    });
    const controller = new AbortController();
    controllers.add(controller);
    let context: MediaContext | undefined;
    let providerSecrets: string[] = [];
    const recordSettlement = async (work: () => Promise<void>) => {
      const start = deps.now();
      try {
        await work();
        observeMedia(deps.observer, {
          ...mediaJobEvent(job),
          kind: 'settlement',
          result: 'completed',
          durationMs: deps.now() - start,
        });
      } catch (error) {
        observeMedia(deps.observer, {
          ...mediaJobEvent(job),
          kind: 'settlement',
          result: 'failed',
          durationMs: deps.now() - start,
        });
        throw error;
      }
    };
    const settle = (
      usage: Parameters<MediaServiceDependencies['accounting']['settle']>[1],
      currentContext: MediaContext,
    ) => recordSettlement(() => deps.accounting.settle(job, usage, currentContext));
    let serial = Promise.resolve();
    const leased = (operation: () => Promise<void>) => {
      const work = serial.then(operation);
      serial = work.catch(() => undefined);
      return work;
    };
    const fence = () => ({
      scope: { tenantId: job.tenantId, ownerId: job.ownerId },
      jobId: job.jobId,
      leaseToken: initial.leaseToken ?? '',
      expectedVersion: job.version,
    });
    const assertPublicationActive = () => {
      if (job.publicationExpiresAt && job.publicationExpiresAt.getTime() <= deps.now())
        throw new MediaServiceError(
          'queue_expired',
          410,
          'The originating retention window expired before dispatch.',
        );
    };
    const refresh = async () => {
      const current = await deps.repository.getMediaJob(fence().scope, job.jobId);
      if (
        !current ||
        current.leaseToken !== initial.leaseToken ||
        (current.leaseUntil?.getTime() ?? 0) <= deps.now()
      ) {
        controller.abort();
        throw new MediaServiceError('version_conflict', 409, 'The job lease changed.');
      }
      job = current;
      if (job.cancelRequestedAt) title?.controller.abort();
    };
    const observe = async (observation: MediaJobObservation) => {
      if (
        observation.releaseLease ||
        ['succeeded', 'failed', 'cancelled'].includes(observation.phase)
      )
        await finishTitle();
      return leased(async () => {
        await refresh();
        const changed = await deps.repository.recordMediaJobObservation({
          ...fence(),
          observation,
          now: new Date(deps.now()).toISOString(),
        });
        if (!changed) {
          await refresh();
          throw new MediaServiceError('version_conflict', 409, 'The job changed.');
        }
        const previousPhase = job.phase;
        if (mediaActivityChanged(job, changed)) {
          void deps
            .publishActivity?.(fence().scope, {
              threadId: changed.threadId,
              version: changed.version,
            })
            .catch((error) =>
              deps.log(
                'Media activity delivery failed; snapshots remain available.',
                error instanceof Error ? error : undefined,
              ),
            );
        }
        job = changed;
        if (job.phase !== previousPhase) {
          observeMedia(deps.observer, {
            ...mediaJobEvent(job),
            kind: 'transition',
            result: 'completed',
            previousPhase,
            durationMs: deps.now() - phaseStartedAt,
          });
          phaseStartedAt = deps.now();
        }
      });
    };
    const renewal = setInterval(() => {
      void leased(async () => {
        await refresh();
        const updated = await deps.repository.renewMediaJob({
          ...fence(),
          now: new Date(deps.now()).toISOString(),
          leaseMs: baseConfig.worker.leaseMs,
        });
        if (!updated) {
          controller.abort();
          return;
        }
        job = updated;
      }).catch(() => controller.abort());
    }, baseConfig.worker.renewEveryMs);
    renewal.unref();

    try {
      context = await deps.loadContext(fence().scope);
      controller.signal.throwIfAborted();
      if (hasRejectedMediaSubmission(job)) {
        const currentContext = context;
        await recordSettlement(() => deps.accounting.release(job, currentContext));
        await observe({ phase: 'failed', error: { code: 'provider_rejected' } });
        return;
      }
      const terminalRecovery = getMediaTerminalRecovery(job);
      if (terminalRecovery) {
        await observe({
          phase: 'reconciling',
          provider: {
            ...job.provider,
            certainty: 'terminal',
            recovery: {
              ...job.provider.recovery,
              terminalStatus: terminalRecovery.status,
              usage: terminalRecovery.usage,
            },
          },
        });
        await settle(terminalRecovery.usage, context);
        await observe({
          phase: terminalRecovery.status,
          provider: { ...job.provider, certainty: 'terminal' },
          ...(terminalRecovery.status === 'failed' ? { error: { code: 'provider_rejected' } } : {}),
        });
        return;
      }
      const currentContext = context;
      const loadProvider = async () => {
        const configuredIntegration = currentContext.config.integrations.find(
          (entry) => entry.id === job.execution.connectionId,
        );
        if (job.phase === 'queued' && configuredIntegration?.enabled === false) {
          throw new MediaServiceError('forbidden', 403, 'This media provider is disabled.');
        }
        const integration = resolveMediaJobIntegration(job, currentContext.config);
        const adapter = adapters.get(job.execution.api);
        if (!integration || !adapter) {
          throw new MediaServiceError(
            'not_ready',
            409,
            'The original media connection is unavailable.',
          );
        }
        const connection = await deps.resolveConnection({
          scope: currentContext.scope,
          integration,
          appConfig: currentContext.appConfig,
          minValidityMs: currentContext.config.credentials.minValidityAtDispatchMs,
          user: currentContext.user,
        });
        if (!isMediaConnectionBinding(connection, job.execution.bindingRevision)) {
          throw new MediaServiceError(
            'credentials_required',
            409,
            'The original provider credential binding changed.',
          );
        }
        providerSecrets = mediaDiagnosticSecrets(connection.headers);
        const providerContext: MediaProviderContext = {
          jobId: job.jobId,
          connection,
          config: currentContext.config,
          transport: scopeMediaTransport(
            deps.transport,
            connection.allowedAddresses,
            currentContext.config.recovery,
          ),
          signal: controller.signal,
        };
        return { integration, adapter, providerContext };
      };
      let loadedProvider: ReturnType<typeof loadProvider> | undefined;
      const getProvider = () => (loadedProvider ??= loadProvider());
      const download = async (part: Extract<MediaProviderPart, { kind: 'image' | 'video' }>) => {
        const { adapter, providerContext } = await getProvider();
        return adapter.download(part, providerContext);
      };
      let result: MediaProviderResult;
      if (job.phase === 'queued') {
        assertPublicationActive();
        assertMediaAccess(context, true);
        if (job.execution.accountingMode !== mediaAccountingMode(context.appConfig)) {
          throw new MediaServiceError(
            'not_ready',
            409,
            'Media accounting policy changed before dispatch.',
          );
        }
        if (deps.now() - job.createdAt.getTime() > context.config.queue.maxQueueAgeMs) {
          await observe({
            phase: 'failed',
            provider: { certainty: 'unsubmitted' },
            error: { code: 'queue_expired' },
          });
          return;
        }
        const admitted = await deps.repository.acquireMediaPermits({
          scope: context.scope,
          jobId: job.jobId,
          permits: [
            { kind: 'deployment', capacity: context.config.execution.maxActiveTotal },
            {
              kind: 'integration',
              capacity: context.config.execution.maxActivePerIntegration,
              key: job.execution.connectionId,
            },
            { kind: 'owner', capacity: context.config.execution.maxActivePerUser },
          ],
        });
        if (!admitted) {
          await observe({
            phase: 'queued',
            dueAt: new Date(deps.now() + context.config.queue.deniedRequeueMs).toISOString(),
            releaseLease: true,
          });
          return;
        }
        const { integration, adapter, providerContext } = await getProvider();
        const prepared = await services.prepare(job.request, context, false, controller.signal);
        controller.signal.throwIfAborted();
        if (!dispatchGate.accepting) {
          await observe({ phase: 'queued', releaseLease: true });
          return;
        }
        if (prepared.providerTag !== job.execution.providerTag) {
          throw new MediaServiceError(
            'stale_catalog',
            409,
            'The selected provider endpoint changed.',
          );
        }
        providerContext.providerTag = job.execution.providerTag;
        providerContext.continuation = prepared.continuation;
        await deps.accounting.reserve(job, integration, context);
        controller.signal.throwIfAborted();
        if (!dispatchGate.accepting) {
          await observe({ phase: 'queued', releaseLease: true });
          return;
        }
        finishDispatch = dispatchGate.enter();
        if (!finishDispatch) {
          await observe({ phase: 'queued', releaseLease: true });
          return;
        }
        await leased(async () => {
          await refresh();
          assertPublicationActive();
          const submitting = await deps.repository.beginMediaSubmission({
            ...fence(),
            now: new Date(deps.now()).toISOString(),
          });
          if (!submitting) {
            throw new MediaServiceError('version_conflict', 409, 'Submission admission changed.');
          }
          job = submitting;
          observeMedia(deps.observer, {
            ...mediaJobEvent(job),
            kind: 'transition',
            result: 'completed',
            previousPhase: 'queued',
            durationMs: deps.now() - phaseStartedAt,
          });
          phaseStartedAt = deps.now();
        });
        controller.signal.throwIfAborted();
        const submit = () => {
          controller.signal.throwIfAborted();
          try {
            const submission = adapter.submit(job.request, prepared.inputs, providerContext);
            title = startTitle(job, currentContext, controller.signal);
            return submission;
          } finally {
            finishDispatch?.();
            finishDispatch = undefined;
          }
        };
        result = deps.modelTracer
          ? await deps.modelTracer.run(
              {
                context,
                jobId: job.jobId,
                threadId: job.threadId,
                kind: 'submission',
                provider: job.execution.api,
                model: job.execution.modelId,
              },
              submit,
              (result) => {
                const usage = result.status === 'running' ? undefined : result.usage;
                return usage
                  ? {
                      input_tokens: usage.inputTokens ?? 0,
                      output_tokens: usage.outputTokens ?? 0,
                      total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
                    }
                  : undefined;
              },
            )
          : await submit();
      } else if (
        job.provider.certainty === 'terminal' &&
        job.provider.recovery?.terminalStatus &&
        job.provider.recovery.terminalStatus !== 'completed'
      ) {
        result = {
          status: job.provider.recovery.terminalStatus,
          usage: job.provider.recovery.usage,
          ...(job.provider.recovery.terminalStatus === 'failed'
            ? { diagnostic: job.provider.recovery.diagnostic }
            : {}),
        };
      } else if (job.provider.certainty === 'terminal' && job.provider.recovery?.parts) {
        result = await restoreMediaOutputResult({ job, context, deps });
      } else if (job.provider.operationId && adapters.get(job.execution.api)?.poll) {
        const { adapter, providerContext } = await getProvider();
        const poll = adapter.poll;
        if (!poll)
          throw new MediaServiceError('not_ready', 409, 'Provider polling is unavailable.');
        const cancellation = adapter.cancel;
        if (
          job.cancelRequestedAt &&
          job.provider.certainty === 'submitted' &&
          job.execution.cancellation &&
          cancellation &&
          !job.provider.cancellationAcknowledged &&
          (!job.provider.cancellationAttemptedAt || cancellation.retry === 'idempotent')
        ) {
          const cancelled = await cancellation.request(
            job.provider.operationId!,
            providerContext,
            () =>
              observe({
                phase: 'running',
                provider: {
                  ...job.provider,
                  cancellationAttemptedAt: new Date(deps.now()).toISOString(),
                },
              }),
          );
          if (
            cancelled.status === 'cancellation_requested' ||
            cancelled.status === 'cancellation_deferred'
          ) {
            const { cancellationAttemptedAt, ...provider } = job.provider;
            await observe({
              phase: 'running',
              provider: {
                ...provider,
                ...(cancelled.status === 'cancellation_requested'
                  ? { cancellationAttemptedAt }
                  : {}),
                cancellationAcknowledged: cancelled.status === 'cancellation_requested',
              },
              dueAt: new Date(deps.now() + context.config.polling.providerIntervalMs).toISOString(),
              releaseLease: true,
            });
            return;
          }
          result = cancelled;
        } else {
          result = await poll(job.provider.operationId, providerContext);
        }
      } else {
        await observe({
          phase: 'requires_attention',
          error: { code: 'submission_uncertain' },
          releaseLease: true,
        });
        return;
      }
      if (result.status === 'running') {
        // Unknown provider states read as running, so polling needs the same bound as recovery.
        if (deps.now() - job.createdAt.getTime() >= context.config.recovery.attentionAfterMs) {
          title?.controller.abort();
          await observe({
            phase: 'requires_attention',
            provider: { ...job.provider, certainty: 'submitted', operationId: result.operationId },
            error: { code: 'submission_uncertain' },
            releaseLease: true,
          });
          return;
        }
        const pendingTitle = title && titleControllers.has(title.controller) ? title : undefined;
        const dueAt = new Date(
          deps.now() + context.config.polling.providerIntervalMs,
        ).toISOString();
        await observe({
          phase: 'running',
          provider: { ...job.provider, certainty: 'submitted', operationId: result.operationId },
          dueAt,
          releaseLease: !pendingTitle,
        });
        if (pendingTitle) {
          await pendingTitle.work;
          await observe({ phase: 'running', dueAt, releaseLease: true });
        }
        return;
      }
      if (result.status === 'failed' || result.status === 'cancelled') {
        title?.controller.abort();
        await observe({
          phase: 'reconciling',
          provider: {
            ...job.provider,
            certainty: 'terminal',
            recovery: {
              ...job.provider.recovery,
              usage: result.usage,
              terminalStatus: result.status,
              ...(result.status === 'failed'
                ? {
                    diagnostic:
                      sanitizeMediaProviderDiagnostic(
                        result.diagnostic,
                        context.config.recovery.maxDiagnosticMessageChars,
                        providerSecrets,
                      ) ?? job.provider.recovery?.diagnostic,
                  }
                : {}),
            },
          },
        });
        await settle(result.usage, context);
        await observe({
          phase: result.status,
          provider: { ...job.provider, certainty: 'terminal' },
          ...(result.status === 'failed' ? { error: { code: 'provider_rejected' } } : {}),
        });
        return;
      }
      const outputs = await publishMediaOutputs({
        getJob: () => job,
        context,
        deps,
        result,
        observe,
        download,
      });
      await settle(result.usage, context);
      await observe({
        phase: 'succeeded',
        outputs,
        provider: { ...job.provider, certainty: 'terminal' },
      });
    } catch (error) {
      title?.controller.abort();
      if (controller.signal.aborted) {
        return;
      }
      attemptFailed = true;
      let code: MediaErrorCode = 'submission_uncertain';
      if (error instanceof MediaServiceError) code = error.code;
      else if (error instanceof MediaProviderError && error.certainty === 'rejected')
        code = 'provider_rejected';
      failureCode = code;
      if (error instanceof MediaProviderError) {
        deps.log(
          `[media] Job ${job.jobId} provider request ${error.certainty} (${error.reason ?? 'unclassified'}).`,
          new MediaProviderError(error.certainty, error.status, error.reason),
        );
      } else if (!(error instanceof MediaServiceError)) {
        deps.log(
          `[media] Job ${job.jobId} failed unexpectedly.`,
          error instanceof Error ? error : undefined,
        );
      }
      const rejectedSubmission =
        error instanceof MediaProviderError &&
        error.certainty === 'rejected' &&
        job.phase === 'submitting';
      const safeRejection = job.provider.certainty === 'unsubmitted' || rejectedSubmission;
      try {
        const diagnostic =
          error instanceof MediaProviderError
            ? sanitizeMediaProviderDiagnostic(
                error.diagnostic,
                (context?.config ?? baseConfig).recovery.maxDiagnosticMessageChars,
                providerSecrets,
              )
            : undefined;
        if (diagnostic || rejectedSubmission) {
          await observe({
            phase: job.phase === 'submitting' ? 'reconciling' : job.phase,
            provider: {
              ...job.provider,
              ...(rejectedSubmission ? { certainty: 'terminal' } : {}),
              recovery: {
                ...job.provider.recovery,
                ...(diagnostic ? { diagnostic } : {}),
                ...(rejectedSubmission
                  ? { terminalStatus: 'failed', rejectedSubmission: true }
                  : {}),
              },
            },
            ...(rejectedSubmission ? { error: { code: 'provider_rejected' } } : {}),
          });
        }
        if (
          context &&
          job.phase === 'ingesting' &&
          job.provider.certainty === 'terminal' &&
          error instanceof MediaServiceError &&
          ['unsupported', 'invalid_request', 'output_expired'].includes(error.code)
        ) {
          await settle(job.provider.recovery?.usage, context);
          await observe({
            phase: 'failed',
            error: { code },
            provider: { ...job.provider, certainty: 'terminal' },
          });
          return;
        }
        if (safeRejection) {
          if (context) {
            const currentContext = context;
            await recordSettlement(() => deps.accounting.release(job, currentContext));
          }
          await observe({
            phase: 'failed',
            error: { code },
            provider: {
              ...job.provider,
              certainty: job.provider.certainty === 'unsubmitted' ? 'unsubmitted' : 'terminal',
            },
          });
        } else {
          const recoveryConfig = context?.config ?? baseConfig;
          const recoveryFailures = (job.recoveryFailures ?? 0) + 1;
          const retryIngestion =
            recoveryFailures < recoveryConfig.recovery.maxAttempts &&
            (job.provider.operationId || job.provider.certainty === 'terminal') &&
            !(
              error instanceof MediaServiceError &&
              [
                'credentials_required',
                'credentials_expired',
                'not_ready',
                'output_expired',
              ].includes(error.code)
            ) &&
            deps.now() - job.createdAt.getTime() <
              (context?.config.recovery.attentionAfterMs ?? baseConfig.recovery.attentionAfterMs);
          const recoveryPhase = job.provider.certainty === 'terminal' ? 'ingesting' : 'running';
          await observe({
            phase: retryIngestion ? recoveryPhase : 'requires_attention',
            error: { code },
            recoveryFailures,
            releaseLease: true,
            dueAt: new Date(
              deps.now() +
                Math.min(
                  recoveryConfig.recovery.maxRetryMs,
                  recoveryConfig.polling.providerIntervalMs *
                    2 ** Math.min(30, recoveryFailures - 1),
                ),
            ).toISOString(),
          });
        }
      } catch (reconciliation) {
        (deps.warn ?? deps.log)(
          '[media] Reconciliation will resume after the job lease expires.',
          reconciliation instanceof Error ? reconciliation : undefined,
        );
      }
    } finally {
      finishDispatch?.();
      await finishTitle();
      const attemptResult = attemptFailed ? 'failed' : 'completed';
      observeMedia(deps.observer, {
        ...mediaJobEvent(job),
        kind: 'attempt',
        result: controller.signal.aborted ? 'interrupted' : attemptResult,
        failureCode,
        durationMs: deps.now() - startedAt,
      });
      clearInterval(renewal);
      controllers.delete(controller);
      await serial;
      await deps.repository.releaseMediaPermits({ scope: fence().scope, jobId: job.jobId });
    }
  }

  async function attempt<T>(
    message: string,
    operation: () => Promise<T>,
    kind?: 'cleanup' | 'settlement',
    task?: MediaLifecycleEvent['task'],
  ): Promise<T | undefined> {
    const start = deps.now();
    try {
      const result = await operation();
      if (kind)
        observeMedia(deps.observer, {
          kind,
          task,
          result: 'completed',
          durationMs: deps.now() - start,
        });
      return result;
    } catch (cause) {
      if (kind)
        observeMedia(deps.observer, {
          kind,
          task,
          result: 'failed',
          durationMs: deps.now() - start,
        });
      (deps.warn ?? deps.log)(`[media] ${message}`, cause instanceof Error ? cause : undefined);
      return undefined;
    }
  }

  async function maintain() {
    if (deps.isLeader && !(await deps.isLeader())) return;
    const now = new Date(deps.now()).toISOString();
    const [cleanup, permits, accounting] = await deps.asSystem(() =>
      Promise.all([
        attempt('The media worker could not discover cleanup work.', () =>
          deps.repository.listMediaCleanupScopes({
            now,
            limit: baseConfig.limits.pageSize,
            cursor: cleanupCursor,
          }),
        ),
        attempt(
          'The media worker could not reconcile permits.',
          () =>
            deps.repository.reconcileMediaPermits({
              limit: baseConfig.limits.pageSize,
              cursor: permitCursor,
            }),
          'cleanup',
          'permits',
        ),
        attempt(
          'The media worker could not discover accounting work.',
          () =>
            deps.accounting.scopes?.({
              limit: baseConfig.limits.pageSize,
              cursor: accountingCursor,
            }) ?? Promise.resolve({ items: [], nextCursor: undefined }),
        ),
      ]),
    );
    if (cleanup) cleanupCursor = cleanup.nextCursor;
    if (permits) permitCursor = permits.nextCursor;
    if (accounting) accountingCursor = accounting.nextCursor;
    for (const scope of accounting?.items ?? []) {
      if (stopped) return;
      await attempt(
        'Media accounting reconciliation needs another attempt.',
        () =>
          deps.withScope(scope, async () => {
            await deps.accounting.reconcile?.(scope, baseConfig);
          }),
        'cleanup',
        'accounting',
      );
    }
    for (const scope of cleanup?.items ?? []) {
      if (stopped) return;
      await attempt('Media cleanup needs another attempt.', () =>
        deps.withScope(scope, async () => {
          await attempt(
            'Asset write recovery needs another attempt.',
            () =>
              deps.repository.recoverMediaAssetWrites({
                scope,
                limit: baseConfig.limits.pageSize,
              }),
            'cleanup',
            'asset_write',
          );
          const staleBefore = new Date(
            deps.now() - baseConfig.assets.orphanRetentionMs,
          ).toISOString();
          const writes = await deps.repository.listMediaAssetWritesForCleanup({
            scope,
            staleBefore,
            limit: baseConfig.limits.pageSize,
          });
          for (const write of writes) {
            if (stopped) return;
            await attempt(
              'An abandoned media write could not be removed.',
              async () => {
                try {
                  await deps.storage.discardWrite(scope, write.writeId, staleBefore);
                } catch (error) {
                  await deps.deferAssetWriteDeletion?.(scope, write.writeId);
                  throw error;
                }
              },
              'cleanup',
              'asset_write',
            );
          }
          const reconciled = await attempt(
            'Account deletion reconciliation needs another attempt.',
            () =>
              deps.repository.reconcileMediaAccountDeletion({
                scope,
                limit: baseConfig.limits.pageSize,
                retentionMs: baseConfig.assets.deletedAccountRetentionMs,
              }),
            'cleanup',
            'account_deletion',
          );
          if (reconciled)
            deps.info?.(`[media] Account deletion reconciled for owner ${scope.ownerId}.`);
          await attempt(
            'Native media reconciliation needs another attempt.',
            async () => {
              await deps.reconcileNative?.(scope, baseConfig);
            },
            'cleanup',
            'native',
          );
          await attempt(
            'Native media consumer migration needs another attempt.',
            async () => {
              await deps.reconcileNativeConsumers?.(scope, baseConfig);
            },
            'cleanup',
            'native',
          );
          await attempt(
            'Media file consumer reconciliation needs another attempt.',
            async () => {
              await deps.reconcileFileConsumers?.(scope, baseConfig);
            },
            'cleanup',
            'consumers',
          );
          await attempt(
            'Expired thread retirement needs another attempt.',
            () =>
              deps.repository.retireExpiredMediaThreads({
                scope,
                now,
                limit: baseConfig.limits.pageSize,
              }),
            'cleanup',
            'retirement',
          );
          await attempt(
            'Thread retirement reconciliation needs another attempt.',
            () =>
              deps.repository.reconcileMediaRetirements({
                scope,
                limit: baseConfig.limits.pageSize,
              }),
            'cleanup',
            'retirement',
          );
          const retiring = await deps.repository.listMediaRetiringAssets({
            scope,
            limit: baseConfig.limits.pageSize,
            now,
          });
          for (const asset of retiring) {
            if (stopped) return;
            await attempt(
              'An interrupted media deletion could not be completed.',
              async () => {
                try {
                  await deps.storage.remove(scope, asset.file_id);
                } catch (error) {
                  await deps.deferAssetDeletion?.(scope, asset.file_id);
                  throw error;
                }
              },
              'cleanup',
              'retiring_asset',
            );
          }
        }),
      );
    }
  }

  async function scan() {
    let healthy = true;
    const scopes = await deps.asSystem(() =>
      deps.repository.listDueMediaScopes({
        now: new Date(deps.now()).toISOString(),
        limit: baseConfig.limits.maxPageSize,
        cursor: dueCursor,
      }),
    );
    let saturated = false;
    for (const scope of scopes.items) {
      if (stopped) break;
      if (active.size >= baseConfig.execution.maxActiveTotal) {
        saturated = true;
        break;
      }
      const scanned = await attempt('A media queue could not be scanned.', async () => {
        await deps.withScope(scope, async () => {
          await deps.repository.recoverMediaPublications({
            scope,
            limit: baseConfig.limits.pageSize,
            maxRetainers: baseConfig.limits.maxAssetRetainers,
            maxTitleChars: baseConfig.limits.maxTitleChars,
            temporaryRetentionMs: deps.temporaryRetentionMs,
          });
          if (stopped) return;
          const job = await deps.repository.claimMediaJob({
            scope,
            workerId,
            now: new Date(deps.now()).toISOString(),
            leaseMs: baseConfig.worker.leaseMs,
            takeoverSkewMs: baseConfig.worker.takeoverSkewMs,
          });
          if (!job) return;
          if (stopped) {
            if (job.leaseToken) {
              await deps.repository.releaseMediaJobLease({
                scope,
                jobId: job.jobId,
                leaseToken: job.leaseToken,
              });
            }
            return;
          }
          void deps
            .withScope(scope, () => runJob(job))
            .catch((cause: unknown) =>
              deps.log(
                `[media] Job ${job.jobId} needs reconciliation.`,
                cause instanceof Error ? cause : undefined,
              ),
            );
        });
        return true;
      });
      if (!scanned) healthy = false;
    }
    // A saturated page is scanned again, so owners after the break are not skipped for a cycle.
    if (!saturated) dueCursor = scopes.nextCursor;
    return healthy;
  }

  function maintenanceTick() {
    if (stopped || maintaining) return;
    maintaining = Promise.all([
      attempt('Media maintenance needs another attempt.', maintain),
      attempt(
        'Local media staging cleanup needs another attempt.',
        async () => {
          await deps.sweepStaging?.(deps.now() - baseConfig.assets.orphanRetentionMs);
        },
        'cleanup',
        'staging',
      ),
    ])
      .then(() => undefined)
      .finally(() => {
        maintaining = undefined;
        if (stopped) return;
        const morePages = cleanupCursor || accountingCursor || permitCursor;
        const delay = morePages
          ? baseConfig.worker.tickMs
          : baseConfig.worker.maintenanceIntervalMs +
            Math.floor(Math.random() * baseConfig.worker.maintenanceJitterMs);
        maintenanceTimer = setTimeout(maintenanceTick, delay);
        maintenanceTimer.unref();
      });
  }

  function tick() {
    if (stopped || scanning) return;
    scanning = scan()
      .then(recordScan)
      .catch((cause: unknown) => {
        recordScan(false);
        deps.log(
          '[media] The media worker could not scan pending work.',
          cause instanceof Error ? cause : undefined,
        );
      })
      .finally(() => {
        scanning = undefined;
        if (!stopped) {
          timer = setTimeout(tick, baseConfig.worker.tickMs);
          timer.unref();
        }
      });
  }

  async function prepareForShutdown() {
    stopped = true;
    setState('draining');
    lifecycle++;
    clearTimeout(timer);
    clearTimeout(maintenanceTimer);
    for (const controller of titleControllers) controller.abort();
    await Promise.allSettled([dispatchGate.close(), starting, scanning, maintaining]);
  }

  function runJob(job: MediaStoredJob): Promise<void> {
    const running = active.get(job.jobId);
    if (running) return running;
    const work = withMediaAttempt(
      deps.observer,
      { ...mediaJobEvent(job), kind: 'attempt', result: 'started' },
      () => execute(job),
    ).finally(() => active.delete(job.jobId));
    active.set(job.jobId, work);
    return work;
  }

  return {
    async start() {
      if (!stopped || starting) return starting;
      setState('starting');
      const generation = ++lifecycle;
      starting = (async () => {
        const activated =
          baseConfig.enabled || (await deps.asSystem(() => deps.repository.hasMediaActivation()));
        if (!activated || generation !== lifecycle) {
          if (!activated) {
            setState('unavailable');
            deps.info?.('[media] Worker inactive; media has never been enabled.');
          }
          return;
        }
        await Promise.all([
          deps.repository.ensureMediaIndexes(),
          deps.accounting.ensureReady?.(),
          deps.ensureReady?.(),
        ]);
        if (generation !== lifecycle) return;
        dispatchGate.open();
        stopped = false;
        setState('armed');
        deps.info?.('[media] Worker started.');
        tick();
        maintenanceTick();
      })()
        .catch((error) => {
          setState('unavailable');
          throw error;
        })
        .finally(() => {
          starting = undefined;
        });
      return starting;
    },
    prepareForShutdown,
    async stop({ budgetMs = baseConfig.worker.shutdownTimeoutMs } = {}) {
      stopped = true;
      setState('draining');
      lifecycle++;
      clearTimeout(timer);
      clearTimeout(maintenanceTimer);
      const budget = Math.max(0, Math.min(budgetMs, baseConfig.worker.shutdownTimeoutMs));
      const expiresAt = Date.now() + budget;
      const closing = dispatchGate.close();
      for (const controller of titleControllers) controller.abort();
      const drain = async () => {
        await Promise.allSettled([closing, starting, scanning, maintaining]);
        await Promise.allSettled(active.values());
      };
      const draining = drain();
      const cleanupMs = Math.min(budget / 2, baseConfig.worker.shutdownCleanupMs);
      await waitForMediaDrain(draining, budget - cleanupMs);
      for (const controller of controllers) {
        controller.abort();
      }
      await waitForMediaDrain(draining, Math.max(0, expiresAt - Date.now()));
      setState('unavailable');
      deps.info?.('[media] Worker stopped.');
    },
    get available() {
      return state === 'armed';
    },
    get health() {
      return health();
    },
    runJob,
  };
}
