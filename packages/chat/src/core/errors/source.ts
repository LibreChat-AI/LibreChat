import type { TMessage } from 'librechat-data-provider';

/** The fields of a message that say who produced a failure and when. */
export type ErrorSource = Pick<TMessage, 'endpoint' | 'model' | 'createdAt'> & {
  /**
   * The agent that ran the failing part: the agent of its own lane in a parallel run, otherwise
   * the agent a handoff earlier in the row made active.
   */
  partAgentId?: string;
};
