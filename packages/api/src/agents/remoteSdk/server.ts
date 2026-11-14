import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { Run, HookRegistry, HOOK_EVENTS, GraphEvents } from '@librechat/agents';
import type { EventHandler, AggregatedHookResult, HookOutput } from '@librechat/agents';
import type { Duplex } from 'node:stream';
import type { Server } from 'node:http';
import type { RemoteSdkFactoryInput, RemoteSdkLimits, RemoteSdkStart, SdkRun } from './types';
import type { SdkAgentIdentity } from './identity';
import { remoteSdkLimits, isRemoteSdkSecret } from './types';
import { RemoteSdkCheckpointer } from './checkpoint';
import { createSdkPeer } from './peer';

const identitySchema = z
  .object({
    runtimeId: z.string().min(1),
    agentId: z.string().min(1),
    runId: z.string().min(1),
    userId: z.string().min(1),
    tenantId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
  })
  .strict();
const claimSchema = z.object({
  protocolVersion: z.literal(1),
  identity: identitySchema,
  threadId: z.string().min(1),
  invocationId: z.string().uuid(),
  iat: z.number(),
  exp: z.number(),
});
const startSchema = z.object({
  operation: z.enum(['start', 'resume']),
  input: z.object({ messages: z.array(z.unknown()) }).passthrough(),
  resume: z.unknown().optional(),
  commandOptions: z
    .object({ update: z.unknown().optional(), goto: z.unknown().optional() })
    .optional(),
  options: z.object({
    configurable: z.record(z.string(), z.unknown()),
    recursionLimit: z.number().int().positive().optional(),
  }),
  handlers: z.array(z.nativeEnum(GraphEvents)).max(128),
  hooks: z.array(z.enum(HOOK_EVENTS)),
  checkpoint: z.boolean(),
  streamLimits: z
    .object({
      maxToolCallArgBytes: z.number().nonnegative().optional(),
      maxToolCallArgBytesByTool: z.record(z.string(), z.number().nonnegative()).optional(),
      maxDeltaEventsPerTurn: z.number().nonnegative().optional(),
    })
    .strict()
    .optional(),
  humanInTheLoop: z.object({ enabled: z.boolean() }).passthrough().optional(),
  agent: z.object({
    id: z.string(),
    name: z.string().optional(),
    instructions: z.string().optional(),
  }),
});

export interface RemoteSdkServerOptions extends Partial<RemoteSdkLimits> {
  runtimeId: string;
  secret: string;
  /** Authorize the signed saved-agent identity against this worker's deployment policy. */
  authorize: (
    identity: Readonly<SdkAgentIdentity>,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
  createRun: (input: RemoteSdkFactoryInput) => Promise<SdkRun>;
  maxConcurrentRuns?: number;
  maxReplayEntries?: number;
  /** Trusted operator diagnostics; errors are never forwarded over the bridge. */
  onError?: (error: unknown) => void;
}

/** A separately hosted, operator-trusted SDK runtime. The caller owns listen/TLS and shutdown. */
export function createRemoteSdkServer(options: RemoteSdkServerOptions): {
  server: Server;
  close: () => Promise<void>;
} {
  if (!isRemoteSdkSecret(options.secret) || !options.runtimeId)
    throw new Error('Invalid SDK runtime server configuration');
  const limits = remoteSdkLimits(options);
  if (
    [options.maxConcurrentRuns ?? 32, options.maxReplayEntries ?? 10_000].some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  )
    throw new Error('Invalid SDK runtime admission limits');
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ protocolVersion: 1 }));
      return;
    }
    res.writeHead(404).end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxFrameBytes,
    perMessageDeflate: false,
  });
  const seen = new Map<string, number>();
  const active = new Set<AbortController>();
  const admitting = new Map<Duplex, AbortController>();
  let closing = false;
  server.on('upgrade', (req, socket, head) => {
    if (closing || active.size + admitting.size >= (options.maxConcurrentRuns ?? 32)) {
      socket.destroy();
      return;
    }
    const admission = new AbortController();
    admitting.set(socket, admission);
    const abortAdmission = () => admission.abort();
    socket.once('close', abortAdmission);
    const deadline = setTimeout(() => {
      admission.abort();
      socket.destroy();
    }, limits.connectTimeoutMs);
    deadline.unref();
    void (async () => {
      const deny = () => {
        if (!socket.destroyed)
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
      };
      if (req.url !== '/sdk' || active.size >= (options.maxConcurrentRuns ?? 32)) {
        deny();
        return;
      }
      let claim: z.infer<typeof claimSchema>;
      try {
        const auth = req.headers.authorization;
        if (!auth?.startsWith('Bearer ')) {
          deny();
          return;
        }
        claim = claimSchema.parse(
          jwt.verify(auth.slice(7), options.secret, {
            algorithms: ['HS256'],
            audience: options.runtimeId,
            issuer: 'librechat-sdk',
            maxAge: '60s',
          }),
        );
        if (
          claim.identity.runtimeId !== options.runtimeId ||
          !(await options.authorize(Object.freeze(claim.identity), admission.signal))
        ) {
          deny();
          return;
        }
      } catch {
        deny();
        return;
      }
      const now = Date.now();
      for (const [id, expiry] of seen) if (expiry <= now) seen.delete(id);
      if (
        closing ||
        claim.exp * 1000 <= now ||
        admission.signal.aborted ||
        socket.destroyed ||
        seen.has(claim.invocationId) ||
        seen.size >= (options.maxReplayEntries ?? 10_000) ||
        active.size >= (options.maxConcurrentRuns ?? 32)
      ) {
        deny();
        return;
      }
      seen.set(claim.invocationId, now + 61_000);
      const controller = new AbortController();
      active.add(controller);
      let upgraded = false;
      socket.once('close', () => {
        if (!upgraded) {
          controller.abort();
          active.delete(controller);
        }
      });
      sockets.handleUpgrade(req, socket, head, (ws) => {
        upgraded = true;
        let started = false;
        let running = false;
        const timer = setTimeout(() => {
          controller.abort();
          ws.close(1000);
        }, limits.maxRunMs);
        timer.unref();
        const cleanup = () => {
          controller.abort();
          clearTimeout(timer);
          if (!running) active.delete(controller);
        };
        ws.once('close', cleanup);
        const peer = createSdkPeer(ws, {
          ...limits,
          timeoutMs: limits.rpcTimeoutMs,
          onClose: cleanup,
          onError: options.onError,
          onFrame: async () => {
            throw new Error('Unexpected runtime frame');
          },
          onCall: async (method, data) => {
            if (method !== 'run' || started) throw new Error('SDK execution already admitted');
            started = true;
            const request = startSchema.parse(data) as RemoteSdkStart;
            const identity = Object.freeze(claim.identity);
            if (
              request.agent.id !== identity.agentId ||
              request.options.configurable?.thread_id !== claim.threadId ||
              request.options.configurable?.run_id !== identity.runId ||
              request.options.configurable?.user_id !== identity.userId
            ) {
              throw new Error('SDK runtime identity mismatch');
            }
            const handlers: Record<string, EventHandler> = {};
            for (const name of request.handlers) {
              if (name === GraphEvents.ON_TOOL_EXECUTE)
                throw new Error('Host tool delegation is not supported');
              handlers[name] = {
                handle: async (event, value, metadata) => {
                  peer.send({ type: 'event', name: event, data: value, metadata });
                },
              };
            }
            let hooks: HookRegistry | undefined;
            if (request.hooks.length) {
              hooks = new HookRegistry();
              for (const event of request.hooks)
                hooks.register(event, {
                  internal: true,
                  hooks: [
                    async (input, hookSignal): Promise<HookOutput> => {
                      const abort = () => controller.abort();
                      hookSignal.addEventListener('abort', abort, { once: true });
                      try {
                        const {
                          errors,
                          hasHookFailures,
                          additionalContexts,
                          stopDecision,
                          ...result
                        } = (await peer.call('hook', {
                          input,
                          matchQuery: 'toolName' in input ? input.toolName : undefined,
                        })) as AggregatedHookResult;
                        if (errors.length || hasHookFailures) throw new Error('Host hook failed');
                        return {
                          ...result,
                          ...(stopDecision ? { decision: stopDecision } : {}),
                          additionalContext: additionalContexts.join('\n'),
                        };
                      } catch {
                        controller.abort();
                        throw new Error('Host policy unavailable');
                      } finally {
                        hookSignal.removeEventListener('abort', abort);
                      }
                    },
                  ],
                });
            }
            const execute = async () => {
              const run = await options.createRun({
                identity,
                config: {
                  runId: identity.runId,
                  customHandlers: handlers,
                  hooks,
                  humanInTheLoop: request.humanInTheLoop,
                  streamLimits: request.streamLimits,
                },
                compileOptions: request.checkpoint
                  ? { checkpointer: new RemoteSdkCheckpointer(peer.call) }
                  : {},
                signal: controller.signal,
                agent: request.agent,
              });
              if (
                !(run instanceof Run) ||
                run.id !== identity.runId ||
                run.Graph?.defaultAgentId !== identity.agentId
              )
                throw new Error('SDK runtime run identity mismatch');
              const callerOptions = {
                ...request.options,
                version: 'v2' as const,
                signal: controller.signal,
              };
              run.returnContent = true;
              const content =
                request.operation === 'resume'
                  ? await run.resume(
                      request.resume,
                      callerOptions,
                      undefined,
                      request.commandOptions,
                    )
                  : await run.processStream(request.input, callerOptions);
              peer.send({
                type: 'done',
                data: {
                  content,
                  messages: run.getRunMessages(),
                  state: {
                    getDiscoveredTools: run.getDiscoveredTools(),
                    getCalibrationRatio: run.getCalibrationRatio(),
                    getFadingTier: run.getFadingTier(),
                    getFadingTiers: run.getFadingTiers(),
                    getFadingTierResetAgentIds: run.getFadingTierResetAgentIds(),
                    getResolvedInstructionOverhead: run.getResolvedInstructionOverhead(),
                    getToolCount: run.getToolCount(),
                    getOutputTruncated: run.getOutputTruncated(),
                    getHandoffOutcome: run.getHandoffOutcome(),
                  },
                  interrupt: run.getInterrupt(),
                  haltReason: run.getHaltReason(),
                  runSteps: run.Graph?.createRunStepResumeState(),
                },
              });
            };
            running = true;
            void execute()
              .catch((error) => {
                try {
                  options.onError?.(error);
                } catch {
                  /* Diagnostics must not prevent cleanup. */
                }
                try {
                  if (ws.readyState === WebSocket.OPEN) peer.send({ type: 'error' });
                } catch {
                  controller.abort();
                } finally {
                  ws.close(1011);
                }
              })
              .finally(() => {
                running = false;
                if (ws.readyState === WebSocket.CLOSED) active.delete(controller);
              });
            return { accepted: true };
          },
        });
      });
    })()
      .catch(() => socket.destroy())
      .finally(() => {
        clearTimeout(deadline);
        socket.removeListener('close', abortAdmission);
        admitting.delete(socket);
      });
  });
  return {
    server,
    close: async () => {
      closing = true;
      for (const [socket, admission] of admitting) {
        admission.abort();
        socket.destroy();
      }
      for (const controller of active) controller.abort();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
