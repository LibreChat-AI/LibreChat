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
import type { RunConfig, RunInterruptResult, RunStep, RunStepClosedEvent } from '@librechat/agents';
import type {
  RemoteSdkHostServices,
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
import { createHostToolService } from './hostTools';
import { createSnapshotReceiver } from './snapshot';
import { createHostPolicyChannel } from './policy';
import { createHostModelChannel } from './model';
import { createHostFileChannel } from './files';
import { createSdkPeer } from './peer';

/** Construct a real local Run whose execution is delegated to one operator-trusted runtime. */
export async function createRemoteSdkRun({
  config,
  identity,
  remote,
  resumeState,
  hostServices,
}: {
  config: RunConfig;
  hostServices?: RemoteSdkHostServices;
  identity: Readonly<SdkAgentIdentity>;
  remote: RemoteSdkOptions;
  resumeState?: RemoteSdkResumeState;
}): ReturnType<typeof Run.create> {
  if (hostServices?.modelProfile && !hostServices.model)
    throw new Error('Builder model profile requires a host model');
  if (config.clientDelegatedToolNames?.length)
    throw new Error('Remote SDK client-owned tools require a supported ownership adapter');
  if (config.providerTextProtection && !hostServices?.providerText)
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
    for (const step of projection.stepMap.values()) {
      if (!step) continue;
      graph.contentIndexMap.set(step.id, graph.contentData.length);
      graph.contentData.push(step);
    }
  }
  const projectionHandlers = createContentIndexOffsetHandlers(
    Object.fromEntries(
      Object.values(GraphEvents).map((event) => [
        event,
        {
          handle: (_event: string, data: SdkEventData) => {
            projection.aggregateContent({
              event,
              data: data as Parameters<typeof projection.aggregateContent>[0]['data'],
            });
            if (event === GraphEvents.ON_RUN_STEP) {
              const step = projection.stepMap.get((data as RunStep).id);
              if (step) {
                const position = graph.contentIndexMap.get(step.id);
                if (position === undefined) {
                  graph.contentIndexMap.set(step.id, graph.contentData.length);
                  graph.contentData.push(step);
                } else graph.contentData[position] = step;
                hydrateResumeRunSteps([step], undefined, graph);
              }
            } else if (event === GraphEvents.ON_RUN_STEP_CLOSED) {
              const closed = data as RunStepClosedEvent;
              const step = graph.getRunStep(closed.id);
              if (step) Object.assign(step, { status: closed.status, closed_at: closed.closed_at });
            }
          },
        },
      ]),
    ),
    resumeState?.content,
  );
  const createResumeState = graph.createRunStepResumeState.bind(graph);
  graph.createRunStepResumeState = () => snapshot?.runSteps ?? createResumeState();
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
  const agentConfig =
    'agents' in config.graphConfig ? config.graphConfig.agents[0] : config.graphConfig;
  const descriptors = (agentConfig.toolDefinitions ?? []).map((definition) => ({
    definition,
    reference: definition.name,
  }));
  const toolHandler = config.customHandlers?.[GraphEvents.ON_TOOL_EXECUTE];
  if (descriptors.length && !toolHandler) throw new Error('Host tool handler is unavailable');
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
    const modelAdmission = hostServices?.modelLifecycle?.attach(options.callbacks) === true;
    const connection = remote.recovery
      ? connectRecoveringSdkSocket({
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
      : legacy();
    const socket = await connection.catch((error) => {
      hostServices?.modelLifecycle?.dispose();
      throw error;
    });
    const execution = new AbortController();
    const providerText = hostServices?.providerText
      ? createHostPolicyChannel(hostServices.providerText, limits)
      : undefined;
    const terminal = createSnapshotReceiver(limits.maxBufferedBytes);
    snapshot = undefined;
    let settled = false;
    const hostInvocations = new Set<Promise<unknown>>();
    let hostFileChannel: ReturnType<typeof createHostFileChannel> | undefined;
    let hostModelChannel: ReturnType<typeof createHostModelChannel> | undefined;
    const result = new Promise<RemoteSdkSnapshot>((resolve, reject) => {
      const finish = (value?: RemoteSdkSnapshot) => {
        if (settled) return;
        settled = true;
        if (value == null || hostServices?.modelLifecycle?.failure())
          reject(
            options.signal?.aborted
              ? Object.assign(new Error('SDK runtime execution cancelled'), { name: 'AbortError' })
              : (hostServices?.modelLifecycle?.failure() ??
                  new Error('SDK runtime execution failed')),
          );
        else resolve(value);
      };
      hostModelChannel = hostServices?.model
        ? createHostModelChannel({
            model: hostServices.model,
            lifecycle: modelAdmission ? hostServices.modelLifecycle : undefined,
            peer: { call: (...args) => peer.call(...args) },
            limits,
            signal: execution.signal,
          })
        : undefined;
      hostFileChannel = hostServices?.files
        ? createHostFileChannel({
            files: hostServices.files,
            identity,
            peer: { call: (...args) => peer.call(...args) },
            limits,
            signal: execution.signal,
          })
        : undefined;
      let hostToolInvoke: ReturnType<typeof createHostToolService> | undefined;
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
          } else if (frame.type === 'snapshot') {
            terminal.accept(frame.data);
          } else if (frame.type === 'done') {
            if (hostInvocations.size) throw new Error('Host tool execution has not drained');
            finish(terminal.finish(frame.data));
          } else if (frame.type === 'error') finish();
          else throw new Error('Unexpected SDK runtime frame');
        },
        onCall: async (method, data, _timeoutMs, signal) => {
          if (execution.signal.aborted || options.signal?.aborted)
            throw new Error('SDK runtime execution stopped');
          if (method.startsWith('files.')) {
            if (!hostFileChannel) throw new Error('Host files are unavailable');
            const invocation = hostFileChannel.call(method, data, signal);
            hostInvocations.add(invocation);
            try {
              return await invocation;
            } finally {
              hostInvocations.delete(invocation);
            }
          }
          if (method === 'model.node.end') {
            if (!modelAdmission || !hostServices?.modelLifecycle)
              throw new Error('Model admission unavailable');
            const admitted = hostServices.modelLifecycle.end(data);
            return { version: 1, ok: true, admitted };
          }
          if (method === 'model.invoke' || method === 'model.stream') {
            if (!hostModelChannel) throw new Error('Host model is unavailable');
            const invocation = hostModelChannel.call(method, data, signal);
            hostInvocations.add(invocation);
            try {
              return await invocation;
            } finally {
              hostInvocations.delete(invocation);
            }
          }
          if (method === 'policy.providerText') {
            if (!providerText) throw new Error('Host provider policy is unavailable');
            return providerText.inspect(
              data,
              signal ? AbortSignal.any([execution.signal, signal]) : execution.signal,
            );
          }
          if (method === 'tools') {
            if (!toolHandler || !descriptors.length) throw new Error('Host tools are unavailable');
            hostToolInvoke ??= createHostToolService({
              identity,
              tools: descriptors,
              handler: toolHandler,
              graph,
              metadata: options.metadata,
              configurable: {
                ...options.configurable,
                user_id: identity.userId,
                run_id: identity.runId,
                thread_id: threadId,
              },
              peer,
              signal: execution.signal,
            });
            const invocation = hostToolInvoke(data, signal);
            hostInvocations.add(invocation);
            try {
              return await invocation;
            } finally {
              hostInvocations.delete(invocation);
            }
          }
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
        transportVersion: 2,
        files: hostFileChannel?.descriptor,
        modelAdmission: modelAdmission
          ? { version: 1, maxEntries: hostServices!.modelLifecycle!.maxEntries }
          : undefined,
        model: hostModelChannel?.descriptor,
        providerText: providerText?.descriptor,
        hostTools: descriptors.length ? descriptors : undefined,
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
        agent: {
          id: identity.agentId,
          name: agent?.name,
          instructions: agent?.instructions,
          model: hostServices?.modelProfile,
        },
      };
      void (async () => {
        const capabilities = (await peer.call('capabilities', null)) as {
          transportVersion?: number;
          hostFiles?: number;
          hostTools?: number;
          providerText?: number;
          hostModel?: number;
          builderModel?: number;
          modelAdmission?: number;
          modelAdmissionWithProviderText?: number;
        };
        if (capabilities?.transportVersion !== 2)
          throw new Error('Worker transport capability unavailable');
        if (hostFileChannel && capabilities?.hostFiles !== 1)
          throw new Error('Worker host file capability unavailable');
        if (modelAdmission && capabilities?.modelAdmission !== 1)
          throw new Error('Worker model admission capability unavailable');
        if (
          modelAdmission &&
          hostServices?.providerText &&
          capabilities?.modelAdmissionWithProviderText !== 1
        )
          throw new Error('Worker protected model admission capability unavailable');
        if (hostServices?.modelProfile && capabilities?.builderModel !== 1)
          throw new Error('Worker builder model capability unavailable');
        if (hostServices?.model && capabilities?.hostModel !== 1)
          throw new Error('Worker host model capability unavailable');
        if (providerText && capabilities?.providerText !== 1)
          throw new Error('Worker provider policy capability unavailable');
        if (descriptors.length) {
          if (capabilities?.hostTools !== 2)
            throw new Error('Worker host tool capability unavailable');
        }
        await peer.call('run', start);
      })().catch(() => finish());
    });
    try {
      snapshot = await result;
      if (snapshot.runSteps) graph.restoreRunStepResumeState(snapshot.runSteps);
      return snapshot.content?.filter((part) => part != null);
    } finally {
      execution.abort();
      hostServices?.modelLifecycle?.dispose();
      providerText?.dispose();
      hostModelChannel?.dispose();
      hostFileChannel?.dispose();
      // A failed/cancelled remote run may leave host cleanup running. Keep the host
      // execution enrolled until those handlers drain, even if the wire has closed.
      await Promise.allSettled([...hostInvocations]);
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
