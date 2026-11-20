import { EModelEndpoint } from 'librechat-data-provider';
import { logger, SystemCapabilities } from '@librechat/data-schemas';
import type { Assistant, TAssistantEndpoint, TAzureConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { CapabilityUser, HasCapabilityFn } from '../middleware/capabilities';

interface AssistantRetrievalRequest {
  params: { id: string };
  body?: { endpoint?: string; model?: string };
  query?: { endpoint?: string; model?: string };
  user: CapabilityUser;
  config: {
    endpoints?: Partial<
      Record<
        EModelEndpoint.assistants | EModelEndpoint.azureAssistants,
        Partial<TAssistantEndpoint>
      >
    > & {
      azureOpenAI?: Pick<
        TAzureConfig,
        'assistants' | 'assistantGroups' | 'groupMap' | 'modelGroupMap'
      >;
    };
  };
}

type AssistantRetrievalResponse = Pick<Response, 'status' | 'json'>;

interface AssistantRetrievalDeps {
  getOpenAIClient: (input: {
    req: AssistantRetrievalRequest;
    res: AssistantRetrievalResponse;
  }) => Promise<{
    openai: { beta: { assistants: { retrieve: (id: string) => Promise<Assistant> } } };
  }>;
  filterAssistants: (input: {
    assistants: Assistant[];
    userId: string;
    assistantsConfig: Partial<TAssistantEndpoint>;
  }) => Assistant[];
  hasCapability: HasCapabilityFn;
}

function notFound(res: AssistantRetrievalResponse): void {
  res.status(404).json({ error: 'Assistant not found' });
}

function firstNonNull<T>(lookups: Promise<T | null>[]): Promise<T | null> {
  if (lookups.length === 0) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    let pending = lookups.length;
    let failed = false;
    const finish = (): void => {
      if (--pending === 0) {
        if (failed) {
          reject(new Error('Assistant retrieval failed'));
        } else {
          resolve(null);
        }
      }
    };
    for (const lookup of lookups) {
      void lookup.then(
        (value) => {
          if (value !== null) {
            resolve(value);
          }
          finish();
        },
        () => {
          failed = true;
          finish();
        },
      );
    }
  });
}

export function createAssistantRetriever({
  getOpenAIClient,
  filterAssistants,
  hasCapability,
}: AssistantRetrievalDeps): (
  req: AssistantRetrievalRequest,
  res: AssistantRetrievalResponse,
) => Promise<void> {
  return async (req, res) => {
    try {
      const endpoint = req.body?.endpoint ?? req.query?.endpoint;
      if (endpoint !== EModelEndpoint.assistants && endpoint !== EModelEndpoint.azureAssistants) {
        notFound(res);
        return;
      }

      const assistantsConfig = req.config.endpoints?.[endpoint];
      const azureConfig = req.config.endpoints?.[EModelEndpoint.azureOpenAI];
      let targets: { model?: string; group?: TAzureConfig['groupMap'][string] }[] = [{}];
      if (endpoint === EModelEndpoint.azureAssistants && azureConfig?.assistants) {
        const model = req.body?.model ?? req.query?.model;
        const groupNames =
          model == null
            ? (azureConfig.assistantGroups ?? [])
            : [typeof model === 'string' ? azureConfig.modelGroupMap[model]?.group : undefined];
        targets = [];
        for (const groupName of new Set(groupNames)) {
          const group = groupName === undefined ? undefined : azureConfig.groupMap[groupName];
          const firstModel = group && Object.keys(group.models)[0];
          if (firstModel === undefined) {
            continue;
          }
          targets.push({ model: model ?? firstModel, group });
        }
        if (targets.length === 0) {
          notFound(res);
          return;
        }
      }

      const canManageAssistants = assistantsConfig
        ? hasCapability(req.user, SystemCapabilities.MANAGE_ASSISTANTS).catch(() => {
            logger.warn('[retrieveAssistant] Capability check failed, denying bypass');
            return false;
          })
        : Promise.resolve(false);
      const assistant = await firstNonNull(
        targets.map(async ({ model, group }) => {
          const clientReq = {
            ...req,
            query: req.query,
            body: { ...req.body, ...(model === undefined ? {} : { model }) },
          };
          let assistant: Assistant;
          try {
            const { openai } = await getOpenAIClient({ req: clientReq, res });
            assistant = await openai.beta.assistants.retrieve(req.params.id);
          } catch (error) {
            if (
              error != null &&
              typeof error === 'object' &&
              'status' in error &&
              (error.status === 404 || error.status === 403)
            ) {
              return null;
            }
            throw error;
          }
          if (
            assistantsConfig &&
            !(await canManageAssistants) &&
            filterAssistants({
              assistants: [assistant],
              userId: req.user.id,
              assistantsConfig,
            }).length === 0
          ) {
            return null;
          }

          if (group) {
            const models = Object.entries(group.models);
            let publicModel = models[0][0];
            if (group.deploymentName !== assistant.model) {
              for (const [model, modelConfig] of models) {
                if (
                  typeof modelConfig === 'object' &&
                  modelConfig?.deploymentName === assistant.model
                ) {
                  publicModel = model;
                  break;
                }
              }
            }
            assistant = { ...assistant, model: publicModel };
          }
          return assistant;
        }),
      );
      if (!assistant) {
        notFound(res);
        return;
      }
      res.json(assistant);
    } catch {
      logger.warn('[retrieveAssistant] Assistant retrieval failed');
      res.status(500).json({ error: 'Failed to load assistant' });
    }
  };
}
