import type { FilterQuery, Model } from 'mongoose';
import type { ActionQuery, IAction } from '~/types';
import { buildFilter, type FieldMap } from '~/utils/criteria';

const sensitiveFields = ['api_key', 'oauth_client_id', 'oauth_client_secret'] as const;

const ACTION_FIELDS: FieldMap<ActionQuery> = {
  actionId: 'action_id',
  agentId: 'agent_id',
  assistantId: 'assistant_id',
  user: 'user',
};

/** Translates domain action criteria into a Mongo filter. */
function actionFilter(query: ActionQuery): FilterQuery<IAction> {
  return buildFilter<ActionQuery, FilterQuery<IAction>>(query, ACTION_FIELDS);
}

export function createActionMethods(mongoose: typeof import('mongoose')): {
  getActions: (query: ActionQuery, includeSensitive?: boolean) => Promise<IAction[]>;
  updateAction: (query: ActionQuery, updateData: Partial<IAction>) => Promise<IAction | null>;
  deleteAction: (query: ActionQuery) => Promise<IAction | null>;
  deleteActions: (query: ActionQuery) => Promise<number>;
} {
  /**
   * Update an action with new data without overwriting existing properties,
   * or create a new action if it doesn't exist.
   */
  async function updateAction(
    query: ActionQuery,
    updateData: Partial<IAction>,
  ): Promise<IAction | null> {
    const Action = mongoose.models.Action as Model<IAction>;
    const options = { new: true, upsert: true };
    return await Action.findOneAndUpdate(actionFilter(query), updateData, options).lean<IAction>();
  }

  /**
   * Retrieves all actions that match the given criteria.
   */
  async function getActions(query: ActionQuery, includeSensitive = false): Promise<IAction[]> {
    const Action = mongoose.models.Action as Model<IAction>;
    const actions = await Action.find(actionFilter(query)).lean<IAction[]>();

    if (!includeSensitive) {
      for (let i = 0; i < actions.length; i++) {
        const metadata = actions[i].metadata;
        if (!metadata) {
          continue;
        }

        for (const field of sensitiveFields) {
          if (metadata[field]) {
            delete metadata[field];
          }
        }
      }
    }

    return actions;
  }

  /**
   * Deletes an action by criteria.
   */
  async function deleteAction(query: ActionQuery): Promise<IAction | null> {
    const Action = mongoose.models.Action as Model<IAction>;
    return await Action.findOneAndDelete(actionFilter(query)).lean<IAction>();
  }

  /**
   * Deletes actions by criteria.
   */
  async function deleteActions(query: ActionQuery): Promise<number> {
    const Action = mongoose.models.Action as Model<IAction>;
    const result = await Action.deleteMany(actionFilter(query));
    return result.deletedCount;
  }

  return {
    getActions,
    updateAction,
    deleteAction,
    deleteActions,
  };
}

export type ActionMethods = ReturnType<typeof createActionMethods>;
