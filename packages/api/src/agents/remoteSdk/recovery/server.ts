import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type {
  RuntimeJournal,
  RuntimeJournalLease,
  RuntimeJournalSession,
  RuntimeJournalState,
} from './journal';
import type { SdkAgentIdentity } from '../identity';
import { createJournalRecoveryLog, journalValue } from './log';
import { RecoverySocket } from './socket';

export interface RecoveryClaim {
  ownerId?: string;
  sessionId: string;
  after: number;
  resume: boolean;
  generation?: string;
}
export const recoveryClaimSchema: z.ZodType<RecoveryClaim> = z
  .object({
    ownerId: z.string().min(1).max(128).optional(),
    sessionId: z.string().uuid(),
    after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    resume: z.boolean(),
    generation: z.string().optional(),
  })
  .strict();
export interface RuntimeRecoveryOptions {
  /** Stable operator identity used for direct reconnect routing. */
  ownerId?: string;
  journal: RuntimeJournal;
  maxDisconnectMs?: number;
}
export interface RuntimeRecoverySession {
  socket: RecoverySocket;
  controller: AbortController;
  needsEngine: boolean;
  begin: () => Promise<void>;
  complete: (state: Exclude<RuntimeJournalState, 'open'>) => Promise<void>;
  attach: (socket: WebSocket, after: number) => void;
  dispose: () => void;
}
/** One live execution owner; reconnect only replaces its wire. A restart never repeats a started Run. */
export function createRuntimeRecovery(
  options: RuntimeRecoveryOptions & {
    maxFrameBytes: number;
    maxBufferedBytes: number;
    onError?: (error: unknown) => void;
  },
): {
  prepare(
    identity: Readonly<SdkAgentIdentity>,
    threadId: string,
    claim: RecoveryClaim,
  ): Promise<RuntimeRecoverySession>;
  close(): void;
} {
  const sessions = new Map<string, { scope: string; value: RuntimeRecoverySession }>();
  const pending = new Map<string, Promise<RuntimeRecoverySession>>();
  let closed = false;
  const graceMs = options.maxDisconnectMs ?? 15000;
  if (options.ownerId != null && (!options.ownerId.length || options.ownerId.length > 128))
    throw new Error('Invalid SDK recovery owner identity');
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0 || options.journal.leaseMs < 30)
    throw new Error('Invalid SDK recovery settings');
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      /* Trusted diagnostics only. */
    }
  };
  const prepare = async (
    identity: Readonly<SdkAgentIdentity>,
    threadId: string,
    claim: RecoveryClaim,
  ): Promise<RuntimeRecoverySession> => {
    if (closed) throw new Error('SDK recovery closed');
    if (claim.ownerId != null && claim.ownerId !== options.ownerId)
      throw new Error('SDK recovery owner mismatch');
    const scope = createHash('sha256')
      .update(
        JSON.stringify([
          identity.runtimeId,
          identity.agentId,
          identity.runId,
          identity.userId,
          identity.tenantId ?? null,
          identity.conversationId ?? null,
          threadId,
          claim.generation ?? null,
        ]),
      )
      .digest('hex');
    const existing = sessions.get(claim.sessionId);
    if (existing) {
      if (existing.scope !== scope || existing.value.socket.readyState !== 1)
        throw new Error('SDK recovery identity mismatch');
      return existing.value;
    }
    const session: RuntimeJournalSession = { sessionId: claim.sessionId, scope };
    const journal = options.journal;
    let lease: RuntimeJournalLease | undefined;
    let page = await journal.read(session, 0, 1);
    let needsEngine = false;
    if (!page.ok) {
      if (page.error.code !== 'missing' || claim.resume)
        throw new Error('SDK recovery session unavailable');
      lease = journalValue(await journal.create(session, randomUUID()));
      page = await journal.read(session, 0, 1);
      needsEngine = true;
    } else if (page.value.state === 'open') {
      const claimed = journalValue(await journal.claim(session, randomUUID()));
      lease = claimed;
      needsEngine = !claimed.started;
    }
    const initial = journalValue(page);
    const log = createJournalRecoveryLog({ journal, session, lease, head: initial.head });
    if (!needsEngine && initial.state === 'open') {
      // The previous process crossed the execution-start barrier. Its effects are uncertain.
      // Replay committed output and fail; never invoke its factory again.
      await log.append(randomUUID(), JSON.stringify({ kind: 'data', payload: '{"type":"error"}' }));
    }
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewing = false;
    let running = false;
    let settled = false;
    const expire = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => socket.terminate(), graceMs);
      deadline.unref();
    };
    const socket = new RecoverySocket({
      log,
      maxFrameBytes: options.maxFrameBytes,
      maxBufferedBytes: options.maxBufferedBytes,
      terminalFailure: initial.state === 'failed' || initial.state === 'cancelled',
      onDisconnect: expire,
      onFailure: (error) => {
        report(error);
        controller.abort();
      },
    });
    const dispose = () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      controller.abort();
      socket.terminate();
      if (sessions.get(claim.sessionId)?.value === value) sessions.delete(claim.sessionId);
    };
    const value: RuntimeRecoverySession = {
      socket,
      controller,
      needsEngine,
      begin: async () => {
        if (!lease || !needsEngine) throw new Error('SDK recovery execution is already started');
        const marker = journalValue(await journal.markStarted(session, lease));
        if (!marker.first) throw new Error('SDK recovery execution is already started');
        running = true;
      },
      complete: async (state) => {
        if (settled) return;
        settled = true;
        running = false;
        await socket.flush();
        if (lease && journalValue(await journal.read(session, 0, 1)).state === 'open')
          journalValue(await journal.finish(session, lease, state, log.head()));
        clearInterval(heartbeat);
        if (socket.readyState !== 1) dispose();
        else expire();
      },
      attach: (wire, after) => {
        clearTimeout(deadline);
        const connection = randomUUID();
        socket.attach(
          wire,
          connection,
          after,
          JSON.stringify({
            version: 1,
            kind: 'ready',
            ownerId: options.ownerId,
            connection,
            sessionId: claim.sessionId,
            received: socket.cursor,
          }),
        );
        if (settled || !needsEngine) expire();
      },
      dispose,
    };
    socket.once('close', () => {
      controller.abort();
      if (!running) dispose();
    });
    if (lease && needsEngine) {
      heartbeat = setInterval(
        () => {
          if (renewing) return;
          renewing = true;
          void journal
            .renew(session, lease!)
            .then(journalValue)
            .catch((error) => {
              if (!settled) {
                report(error);
                dispose();
              }
            })
            .finally(() => {
              renewing = false;
            });
        },
        Math.floor(journal.leaseMs / 3),
      );
      heartbeat.unref();
    }
    if (closed) {
      dispose();
      throw new Error('SDK recovery closed');
    }
    sessions.set(claim.sessionId, { scope, value });
    expire();
    return value;
  };
  return {
    async prepare(identity, threadId, claim) {
      // Serialize admission by session, then recheck the caller's full scope.
      const previous = pending.get(claim.sessionId);
      const operation = (async () => {
        if (previous) await previous.catch(() => undefined);
        return prepare(identity, threadId, claim);
      })();
      pending.set(claim.sessionId, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(claim.sessionId) === operation) pending.delete(claim.sessionId);
      }
    },
    close: () => {
      closed = true;
      for (const entry of [...sessions.values()]) entry.value.dispose();
    },
  };
}
