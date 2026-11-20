import { logger } from '@librechat/data-schemas';
import { EModelEndpoint } from 'librechat-data-provider';
import type {
  BackgroundTaskCancelResponse,
  BackgroundTaskDelivery,
  BackgroundTaskSummary,
  BackgroundTaskIndex,
  TAgentsEndpoint,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response, NextFunction } from 'express';
import type {
  PendingBackgroundCompletionControls,
  PendingBackgroundCompletion,
} from './backgroundCompletion';
import type {
  BackgroundTaskRegistryClass,
  DurableCompletionView,
  BackgroundTask,
} from './background';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types';
import { readDurableCompletions, resolveTaskDelivery } from './background';
import { getAppConfigOptionsFromUser } from '~/app/service';

/** The registry surface the user-facing task routes read and act on. */
export type BackgroundTaskRegistryView = Pick<
  BackgroundTaskRegistryClass,
  'list' | 'requestCancellation'
>;

export interface BackgroundTaskRouteDependencies {
  registry: BackgroundTaskRegistryView;
  /** Durable delivery store; without it the list shows only this process's tasks. */
  pending?: Pick<PendingBackgroundCompletionControls, 'list'>;
}

/** Resolve effective cancellation policy without enumerating code environments. */
export function createBackgroundTaskPolicyMiddleware(deps: {
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
}) {
  return async (req: ServerRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.config = await deps.getAppConfig({
        ...getAppConfigOptionsFromUser(req.user),
        skipRuntimeAugmentation: true,
        failClosed: true,
      });
      next();
    } catch {
      res.status(503).json({ error: 'Background task policy is temporarily unavailable' });
    }
  };
}

const MAX_CONVERSATION_ID_LENGTH = 256;
const MAX_CANCEL_TASK_IDS = 64;
const MAX_TASK_ID_LENGTH = 256;

const validConversationId = (value: string | undefined): value is string =>
  value != null && value.trim() !== '' && value.length <= MAX_CONVERSATION_ID_LENGTH;

const validTaskId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TASK_ID_LENGTH;

/** User cancellation of ordinary tools shares the model tool's opt-in. */
export function ordinaryToolCancellationEnabled(config: TAgentsEndpoint | undefined): boolean {
  return config?.backgroundTasks?.ordinaryToolCancellation === true;
}

const agentsConfig = (req: ServerRequest): TAgentsEndpoint | undefined =>
  req.config?.endpoints?.[EModelEndpoint.agents] as TAgentsEndpoint | undefined;

/**
 * Projects a registry task for the client. Results, artifacts and errors stay
 * server-side, matching the model tool's metadata-only list path.
 */
export function toBackgroundTaskSummary(
  task: BackgroundTask,
  delivery?: BackgroundTaskDelivery,
): BackgroundTaskSummary {
  const settled = task.status !== 'running';
  return {
    taskId: task.id,
    toolName: task.toolName,
    toolCallId: task.toolCallId,
    ...(task.messageId == null ? {} : { messageId: task.messageId }),
    ...(task.stepId == null ? {} : { stepId: task.stepId }),
    status: task.status,
    cancellationRequested: task.cancellationRequestedAt != null,
    startedAt: new Date(task.createdAt).toISOString(),
    ...(settled && task.settledAt != null
      ? { settledAt: new Date(task.settledAt).toISOString() }
      : {}),
    ...(delivery == null ? {} : { delivery }),
  };
}

type SettledCompletion = PendingBackgroundCompletion &
  Required<Pick<PendingBackgroundCompletion, 'result'>>;

const isSettled = (completion: PendingBackgroundCompletion): completion is SettledCompletion =>
  completion.result != null;

/**
 * A finished result known only to the durable delivery store: it settled on
 * another replica, before a restart, or past this registry's retention, and has
 * not reached the agent. Running work stays owned by its process's registry.
 */
function toCompletionSummary(
  completion: SettledCompletion,
  delivery: Extract<BackgroundTaskDelivery, 'pending' | 'failed'>,
): BackgroundTaskSummary {
  return {
    taskId: completion.taskId,
    toolName: completion.toolName,
    toolCallId: completion.toolCallId,
    status: completion.result.status,
    cancellationRequested: false,
    startedAt: completion.dispatchedAt.toISOString(),
    settledAt: completion.result.settledAt.toISOString(),
    delivery,
  };
}

async function readDurable(
  deps: BackgroundTaskRouteDependencies,
  input: { userId: string; conversationId: string },
  tasks: readonly BackgroundTask[],
): Promise<DurableCompletionView | undefined> {
  if (deps.pending == null) {
    return undefined;
  }
  try {
    return await readDurableCompletions(deps.pending, input, new Set(tasks.map(({ id }) => id)));
  } catch (error) {
    logger.warn('[background] Failed to read undelivered completions for the task list:', error);
    return undefined;
  }
}

/**
 * Lists the caller's background tool tasks for one conversation. The registry
 * is keyed by user and conversation, so another user's tasks are unreachable;
 * the durable delivery store adds whether each finished result has reached the
 * agent, and finished results this process does not hold.
 */
export function createBackgroundTaskIndexHandler(deps: BackgroundTaskRouteDependencies) {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { conversationId } = req.params as { conversationId?: string };
    if (!userId || !validConversationId(conversationId)) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const tasks = deps.registry.list(userId, conversationId);
    const durable = await readDurable(deps, { userId, conversationId }, tasks);
    const body: BackgroundTaskIndex = {
      conversationId,
      tasks: [
        ...tasks.map((task) => toBackgroundTaskSummary(task, resolveTaskDelivery(task, durable))),
        ...(durable?.pending ?? [])
          .filter(isSettled)
          .map((completion) => toCompletionSummary(completion, 'pending')),
        ...(durable?.dead ?? [])
          .filter(isSettled)
          .map((completion) => toCompletionSummary(completion, 'failed')),
      ],
      complete: durable?.pendingTaskIds != null,
      cancellable: ordinaryToolCancellationEnabled(agentsConfig(req)),
    };
    res.status(200).json(body);
  };
}

/**
 * Requests cooperative cancellation of the caller's background tool tasks.
 * Without `taskIds` every running task in the conversation is targeted. Each
 * task reports the registry outcome; `unavailable` means the owning process
 * holds no cancellation handle for it.
 */
export function createBackgroundTaskCancelHandler(deps: BackgroundTaskRouteDependencies) {
  return (req: ServerRequest, res: Response): void => {
    const userId = req.user?.id;
    const { conversationId } = req.params as { conversationId?: string };
    if (!userId || !validConversationId(conversationId)) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (!ordinaryToolCancellationEnabled(agentsConfig(req))) {
      res.status(403).json({ error: 'Background task cancellation is not enabled' });
      return;
    }

    const payload: unknown = req.body;
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
      res.status(400).json({ error: 'Invalid background task cancellation request' });
      return;
    }
    const hasTaskIds = 'taskIds' in payload;
    const requested = hasTaskIds ? payload.taskIds : undefined;
    if (
      hasTaskIds &&
      (!Array.isArray(requested) ||
        requested.length > MAX_CANCEL_TASK_IDS ||
        !requested.every(validTaskId))
    ) {
      res.status(400).json({ error: 'Invalid background task cancellation request' });
      return;
    }

    const taskIds = hasTaskIds
      ? [...new Set(requested as string[])]
      : deps.registry
          .list(userId, conversationId)
          .filter((task) => task.status === 'running')
          .map((task) => task.id);

    const body: BackgroundTaskCancelResponse = {
      results: taskIds.map((taskId) => ({
        taskId,
        status: deps.registry.requestCancellation(userId, conversationId, taskId).status,
      })),
    };
    res.status(200).json(body);
  };
}
