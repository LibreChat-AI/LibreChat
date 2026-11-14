import { z } from 'zod';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import {
  Run,
  executeHooks,
  GraphEvents,
  HOOK_EVENTS,
  createContentAggregator,
  BaseCheckpointSaver,
  TOOL_APPROVAL_EXECUTION_SCOPE_CONFIG_KEY,
} from '@librechat/agents';
import type { RunConfig, RunInterruptResult } from '@librechat/agents';
import type {
  RemoteSdkOptions,
  RemoteSdkSnapshot,
  RemoteSdkStart,
  SdkRunOptions,
  RemoteSdkResumeState,
  SdkEventData,
} from './types';
import type { SdkAgentIdentity } from './identity';
import { hydrateResumeRunSteps, createContentIndexOffsetHandlers } from '../hitl/resume';
import { connectRecoveringSdkSocket } from './recovery/client';
import { remoteSdkLimits, isRemoteSdkSecret } from './types';
import { createSdkPeer } from './peer';

/** Construct a real local Run whose execution is delegated to one operator-trusted runtime. */
export async function createRemoteSdkRun({
  config,
  identity,
  remote,
  resumeState,
}: {
  config: RunConfig;
  identity: Readonly<SdkAgentIdentity>;
  remote: RemoteSdkOptions;
  resumeState?: RemoteSdkResumeState;
}): ReturnType<typeof Run.create> {
  if (config.providerTextProtection)
    throw new Error('Remote SDK provider protection requires a supported policy adapter');
  identity = Object.freeze({ ...identity });
  const limits = remoteSdkLimits(remote);
  const url = new URL(remote.url);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== 'wss:' &&
      !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
    !isRemoteSdkSecret(remote.secret)
  )
    throw new Error('Invalid SDK runtime connection configuration');
  const run = await Run.create(config);
  const graph = run.Graph;
  if (graph == null) throw new Error('SDK runtime graph is unavailable');
  let snapshot: RemoteSdkSnapshot | undefined;
  const projection = createContentAggregator();
  if (resumeState) {
    projection.contentParts.push(...resumeState.content);
    hydrateResumeRunSteps(resumeState.steps, projection.stepMap, graph, resumeState.content);
  }
  const projectionHandlers = createContentIndexOffsetHandlers(
    Object.fromEntries(
      Object.values(GraphEvents).map((event) => [
        event,
        {
          handle: (_event: string, data: SdkEventData) =>
            projection.aggregateContent({
              event,
              data: data as Parameters<typeof projection.aggregateContent>[0]['data'],
            }),
        },
      ]),
    ),
    resumeState?.content,
  );
  graph.getContentParts = () =>
    snapshot?.content ?? projection.contentParts.filter((part) => part != null);
  run.getRunMessages = () => snapshot?.messages ?? [];
  graph.getRunMessages = run.getRunMessages;
  run.getInterrupt = <T>() => snapshot?.interrupt as RunInterruptResult<T> | undefined;
  run.getHaltReason = () => snapshot?.haltReason;
  run.getDiscoveredTools = () => snapshot?.state?.getDiscoveredTools ?? [];
  run.getCalibrationRatio = () => snapshot?.state?.getCalibrationRatio ?? 1;
  run.getFadingTier = () => snapshot?.state?.getFadingTier;
  run.getFadingTiers = () => snapshot?.state?.getFadingTiers ?? {};
  run.getFadingTierResetAgentIds = () => snapshot?.state?.getFadingTierResetAgentIds ?? [];
  run.getResolvedInstructionOverhead = () => snapshot?.state?.getResolvedInstructionOverhead;
  run.getToolCount = () => snapshot?.state?.getToolCount ?? 0;
  run.getOutputTruncated = () => snapshot?.state?.getOutputTruncated ?? false;
  run.getHandoffOutcome = () => snapshot?.state?.getHandoffOutcome;
  const candidate = config.graphConfig.compileOptions?.checkpointer;
  const saver = candidate instanceof BaseCheckpointSaver ? candidate : undefined;
  if (config.humanInTheLoop?.enabled && !saver)
    throw new Error('Remote SDK approvals require a host checkpointer');
  let invoked = false;
  const execute = async (
    operation: RemoteSdkStart['operation'],
    input: RemoteSdkStart['input'],
    options: SdkRunOptions,
    resume?: unknown,
    commandOptions?: RemoteSdkStart['commandOptions'],
  ) => {
    options.signal?.throwIfAborted();
    if (invoked)
      throw new Error('SDK runtime Run already invoked; create a fresh Run for continuation');
    invoked = true;
    const threadId = options.configurable?.thread_id ?? identity.conversationId ?? identity.runId;
    if (
      typeof threadId !== 'string' ||
      (identity.conversationId && identity.conversationId !== threadId)
    )
      throw new Error('SDK runtime thread identity mismatch');
    const boundConfigurable: Record<string, unknown> = {
      ...options.configurable,
      thread_id: threadId,
    };
    const makeToken = (recovery?: import('./recovery/server').RecoveryClaim) =>
      jwt.sign(
        { protocolVersion: 1, identity, threadId, invocationId: randomUUID(), recovery },
        remote.secret,
        {
          algorithm: 'HS256',
          audience: identity.runtimeId,
          issuer: 'librechat-sdk',
          expiresIn: '60s',
        },
      );
    const legacy = async () => {
      const socket = new WebSocket(remote.url, {
        headers: { Authorization: `Bearer ${makeToken()}` },
        handshakeTimeout: limits.connectTimeoutMs,
        maxPayload: limits.maxFrameBytes,
        followRedirects: false,
      });
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          socket.terminate();
          reject(
            Object.assign(new Error('SDK runtime connection cancelled'), { name: 'AbortError' }),
          );
        };
        const cleanup = () => options.signal?.removeEventListener('abort', abort);
        socket.once('open', () => {
          cleanup();
          resolve();
        });
        socket.once('error', () => {
          cleanup();
          reject(new Error('SDK runtime connection failed'));
        });
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });

      return socket;
    };
    const socket = remote.recovery
      ? await connectRecoveringSdkSocket({
          url: remote.url,
          token: makeToken,
          generation:
            typeof boundConfigurable.__librechat_checkpoint_ns === 'string'
              ? boundConfigurable.__librechat_checkpoint_ns
              : undefined,
          limits,
          recovery: remote.recovery,
          signal: options.signal,
          onError: remote.onError,
        })
      : await legacy();
    const execution = new AbortController();
    snapshot = undefined;
    let settled = false;
    const result = new Promise<RemoteSdkSnapshot>((resolve, reject) => {
      const finish = (value?: RemoteSdkSnapshot) => {
        if (settled) return;
        settled = true;
        if (value == null)
          reject(
            options.signal?.aborted
              ? Object.assign(new Error('SDK runtime execution cancelled'), { name: 'AbortError' })
              : new Error('SDK runtime execution failed'),
          );
        else resolve(value);
      };
      const peer = createSdkPeer(socket, {
        ...limits,
        timeoutMs: limits.rpcTimeoutMs,
        onClose: () => {
          execution.abort();
          finish();
        },
        onError: remote.onError,
        onFrame: async (frame) => {
          if (frame.type === 'event') {
            const event = z.nativeEnum(GraphEvents).parse(frame.name);
            if (event === GraphEvents.ON_TOOL_EXECUTE)
              throw new Error('Remote events cannot invoke host tools');
            await projectionHandlers?.[event]?.handle(
              event,
              frame.data as SdkEventData,
              frame.metadata,
              graph,
            );
            await config.customHandlers?.[event]?.handle(
              event,
              frame.data as SdkEventData,
              frame.metadata,
              graph,
            );
          } else if (frame.type === 'done') {
            finish(frame.data as RemoteSdkSnapshot);
          } else if (frame.type === 'error') finish();
          else throw new Error('Unexpected SDK runtime frame');
        },
        onCall: async (method, data) => {
          if (execution.signal.aborted || options.signal?.aborted)
            throw new Error('SDK runtime execution stopped');
          if (method === 'hook') {
            if (config.hooks == null) throw new Error('Host hooks are unavailable');
            const args = data as {
              input: Parameters<typeof executeHooks>[0]['input'];
              matchQuery?: string;
            };
            if (
              !HOOK_EVENTS.includes(args.input?.hook_event_name) ||
              !config.hooks.hasHookFor(args.input.hook_event_name, identity.runId)
            )
              throw new Error('Host hook is not enabled');
            return executeHooks({
              registry: config.hooks,
              input: { ...args.input, runId: identity.runId, threadId },
              matchQuery: args.matchQuery,
              sessionId: identity.runId,
              signal: execution.signal,
            });
          }
          if (!saver || typeof saver !== 'object' || !method.startsWith('checkpoint.'))
            throw new Error('Unsupported SDK operation');
          const args = data as Parameters<typeof saver.put>;
          const scope = (config: Parameters<typeof saver.getTuple>[0], before = false) => {
            const configurable = config?.configurable;
            const ns = configurable?.checkpoint_ns ?? '';
            if (
              ((!before || configurable?.thread_id != null) &&
                configurable?.thread_id !== threadId) ||
              (configurable?.__librechat_checkpoint_ns != null &&
                configurable.__librechat_checkpoint_ns !==
                  boundConfigurable.__librechat_checkpoint_ns) ||
              typeof ns !== 'string' ||
              (configurable?.checkpoint_id != null &&
                typeof configurable.checkpoint_id !== 'string')
            ) {
              throw new Error('Checkpoint scope mismatch');
            }
            return {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: ns,
                ...(configurable?.checkpoint_id != null
                  ? { checkpoint_id: configurable.checkpoint_id }
                  : {}),
                ...Object.fromEntries(
                  Object.entries(boundConfigurable).filter(([key]) =>
                    key.startsWith('__librechat_'),
                  ),
                ),
              },
            };
          };
          args[0] = scope(args[0]);
          if (method === 'checkpoint.getTuple') return saver.getTuple(args[0]);
          if (method === 'checkpoint.put') return saver.put(...args);
          if (method === 'checkpoint.putWrites')
            return saver.putWrites(...(data as Parameters<typeof saver.putWrites>));
          if (method === 'checkpoint.list') {
            const list = z
              .object({
                limit: z.number().int().nonnegative().optional(),
                filter: z.record(z.string(), z.unknown()).optional(),
                before: z
                  .object({ configurable: z.record(z.string(), z.unknown()).optional() })
                  .optional(),
              })
              .strict()
              .parse(Array.isArray(data) ? (data[1] ?? {}) : {});
            const limit = Math.min(list.limit ?? 32, 32);
            if (limit === 0) return [];
            const tuples = [];
            for await (const tuple of saver.list(args[0], {
              limit,
              filter: list.filter,
              before: list.before ? scope(list.before, true) : undefined,
            })) {
              tuples.push(tuple);
              if (tuples.length >= limit) break;
            }
            return tuples;
          }
          throw new Error('Unsupported SDK operation');
        },
      });
      const abort = () => {
        execution.abort();
        socket.close(1000);
        finish();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setTimeout(abort, limits.maxRunMs);
      timer.unref();
      socket.once('close', () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      });
      const agent =
        'agents' in config.graphConfig ? config.graphConfig.agents[0] : config.graphConfig;
      const start: RemoteSdkStart = {
        operation,
        input,
        resume,
        commandOptions,
        options: {
          recursionLimit: options.recursionLimit,
          configurable: {
            thread_id: threadId,
            checkpoint_ns: options.configurable?.checkpoint_ns,
            __librechat_checkpoint_ns: options.configurable?.__librechat_checkpoint_ns,
            [TOOL_APPROVAL_EXECUTION_SCOPE_CONFIG_KEY]:
              options.configurable?.[TOOL_APPROVAL_EXECUTION_SCOPE_CONFIG_KEY],
            run_id: identity.runId,
            user_id: identity.userId,
          },
        },
        handlers: [
          ...new Set([
            ...Object.keys(config.customHandlers ?? {}),
            GraphEvents.ON_RUN_STEP,
            GraphEvents.ON_RUN_STEP_DELTA,
            GraphEvents.ON_RUN_STEP_COMPLETED,
            GraphEvents.ON_RUN_STEP_CLOSED,
            GraphEvents.ON_MESSAGE_DELTA,
            GraphEvents.ON_REASONING_DELTA,
          ]),
        ].filter((name) => name !== GraphEvents.ON_TOOL_EXECUTE),
        hooks: HOOK_EVENTS.filter((event) => config.hooks?.hasHookFor(event, identity.runId)),
        checkpoint: Boolean(saver),
        humanInTheLoop: config.humanInTheLoop,
        streamLimits: config.streamLimits,
        agent: { id: identity.agentId, name: agent?.name, instructions: agent?.instructions },
      };
      void peer.call('run', start).catch(() => finish());
    });
    try {
      snapshot = await result;
      if (snapshot.runSteps) graph.restoreRunStepResumeState(snapshot.runSteps);
      return snapshot.content?.filter((part) => part != null);
    } finally {
      socket.close(1000);
      if ('waitForClose' in socket) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          socket.waitForClose(),
          new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              socket.terminate();
              resolve();
            }, remote.recovery!.maxDisconnectMs);
          }),
        ]);
        clearTimeout(timeout);
      }
      if (snapshot?.interrupt == null) config.hooks?.clearSession(identity.runId);
    }
  };
  run.processStream = (input, options) => {
    if (!('messages' in input)) throw new Error('Use the SDK resume entry point for continuation');
    return execute('start', input, options);
  };
  run.resume = (resume, options, _streamOptions, commandOptions) =>
    execute('resume', { messages: [] }, options, resume, commandOptions);
  return run;
}
