import { createContext } from 'react';
import type { Context } from 'react';

/** One durable child task's identity, which retained content and receipts are read under. */
export type TaskContentScope = {
  parentConversationId: string;
  threadId: string;
  taskId: string;
};

/** The task a transcript renders for; `null` where it is not a durable task. */
export const TaskContentScopeContext: Context<TaskContentScope | null> =
  createContext<TaskContentScope | null>(null);
