import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type { ConversationMethods } from '@librechat/data-schemas';
import type {
  AgentEventActorDependencies,
  ExecuteAgentEventActorInput,
  ExecuteAgentEventActorResult,
  ResumeAgentEventActorInput,
} from './actor';
import type { AgentTurnContinuationStrategy } from '../plan';
import { executeAgentEventActor, resumeAgentEventActor } from './actor';

export interface AgentEventActorTurnOwner {
  user: string;
  tenantId?: string;
  conversationId: string;
}

export type AgentEventActorCheckpointTurn<T> =
  | { kind: 'execute'; input: ExecuteAgentEventActorInput<T> }
  | { kind: 'resume'; input: ResumeAgentEventActorInput<T> };

export interface AgentEventActorHistoryTurn<T> {
  owner: AgentEventActorTurnOwner;
  persistToken(token: string): Promise<void>;
  invoke(): Promise<T>;
}

export interface CreateAgentEventActorTurnInput<T> {
  strategy: AgentTurnContinuationStrategy;
  checkpoint?: AgentEventActorCheckpointTurn<T>;
  history?: AgentEventActorHistoryTurn<T>;
}

export interface AgentEventActorTurnDependencies {
  actor?: AgentEventActorDependencies;
  history?: {
    begin: ConversationMethods['beginAgentEventActorLegacyTurn'];
    complete: ConversationMethods['completeAgentEventActorLegacyTurn'];
  };
}

export type AgentEventActorTurnResult<T> =
  | ({ adapter: 'checkpoint' } & ExecuteAgentEventActorResult<T>)
  | { adapter: 'history'; value: T };

export interface AgentEventActorTurn<T> {
  run(): Promise<AgentEventActorTurnResult<T>>;
  historyPersisted(): Promise<void>;
}

type EventActorTurnError = Error & { code: string; status: number };

function requireCheckpoint<T>(
  input: CreateAgentEventActorTurnInput<T>,
  deps: AgentEventActorTurnDependencies,
): {
  turn: AgentEventActorCheckpointTurn<T>;
  actor: AgentEventActorDependencies;
} {
  if (input.checkpoint == null || deps.actor == null) {
    throw new Error('Event actor checkpoint adapter is unavailable');
  }
  return { turn: input.checkpoint, actor: deps.actor };
}

function requireHistory<T>(
  input: CreateAgentEventActorTurnInput<T>,
  deps: AgentEventActorTurnDependencies,
): {
  turn: AgentEventActorHistoryTurn<T>;
  history: NonNullable<AgentEventActorTurnDependencies['history']>;
} {
  if (input.history == null || deps.history == null) {
    throw new Error('Event actor history adapter is unavailable');
  }
  return { turn: input.history, history: deps.history };
}

async function completeHistoryTurn(
  owner: AgentEventActorTurnOwner,
  token: string,
  complete: ConversationMethods['completeAgentEventActorLegacyTurn'],
): Promise<boolean> {
  return complete({
    user: owner.user,
    conversationId: owner.conversationId,
    ...(owner.tenantId == null ? {} : { tenantId: owner.tenantId }),
    token,
  });
}

/** One Event Actor turn interface with checkpoint and history as private state-loading adapters. */
export function createAgentEventActorTurn<T>(
  input: CreateAgentEventActorTurnInput<T>,
  deps: AgentEventActorTurnDependencies,
): AgentEventActorTurn<T> {
  let started = false;
  let historyToken: string | undefined;
  let historyOwner: AgentEventActorTurnOwner | undefined;

  const run = async (): Promise<AgentEventActorTurnResult<T>> => {
    if (started) {
      throw new Error('Event actor turn already started');
    }
    started = true;

    if (input.strategy === 'checkpoint') {
      const { turn, actor } = requireCheckpoint(input, deps);
      const result =
        turn.kind === 'resume'
          ? await resumeAgentEventActor(turn.input, actor)
          : await executeAgentEventActor(turn.input, actor);
      return { adapter: 'checkpoint', ...result };
    }

    const { turn, history } = requireHistory(input, deps);
    const token = randomUUID();
    const acquired = await history.begin({
      user: turn.owner.user,
      conversationId: turn.owner.conversationId,
      ...(turn.owner.tenantId == null ? {} : { tenantId: turn.owner.tenantId }),
      token,
    });
    if (!acquired) {
      throw Object.assign(new Error('The event actor is temporarily unavailable'), {
        code: 'EVENT_ACTOR_NOT_READY',
        status: 409,
      }) as EventActorTurnError;
    }
    historyToken = token;
    historyOwner = turn.owner;
    try {
      await turn.persistToken(token);
    } catch (error) {
      try {
        const completed = await completeHistoryTurn(turn.owner, token, history.complete);
        if (completed) {
          historyToken = undefined;
          historyOwner = undefined;
        } else {
          logger.error(
            `[event-actor] Unstarted history turn ${token} was not released; durable error handling will retry`,
          );
        }
      } catch (completionError) {
        logger.error('[event-actor] Failed to release an unstarted history turn', completionError);
      }
      throw error;
    }
    return { adapter: 'history', value: await turn.invoke() };
  };

  const historyPersisted = async (): Promise<void> => {
    if (historyToken == null || historyOwner == null || deps.history == null) {
      return;
    }
    const token = historyToken;
    const owner = historyOwner;
    try {
      const completed = await completeHistoryTurn(owner, token, deps.history.complete);
      if (completed) {
        historyToken = undefined;
        historyOwner = undefined;
      } else {
        logger.error(
          `[event-actor] History turn ${token} was not settled; invocation forks remain blocked`,
        );
      }
    } catch (error) {
      logger.error(
        `[event-actor] Failed to settle history turn ${token}; invocation forks remain blocked`,
        error,
      );
    }
  };

  return Object.freeze({ run, historyPersisted });
}

/** Read-compatible settlement for a history turn created by an earlier generation. */
export function settleAgentEventActorHistoryTurn(
  input: AgentEventActorTurnOwner & { token: string },
  complete: ConversationMethods['completeAgentEventActorLegacyTurn'],
): Promise<boolean> {
  return completeHistoryTurn(input, input.token, complete);
}
